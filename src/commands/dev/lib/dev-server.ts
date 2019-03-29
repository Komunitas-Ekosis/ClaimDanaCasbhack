import url from 'url';
import http from 'http';
import fs from 'fs-extra';
import chalk from 'chalk';
import qs from 'querystring';
import rawBody from 'raw-body';
import { inspect } from 'util';
import listen from 'async-listen';
import httpProxy from 'http-proxy';
import { randomBytes } from 'crypto';
import serveHandler from 'serve-handler';
import { basename, dirname, relative } from 'path';
import { lookup as lookupMimeType } from 'mime-types';

import { Output } from '../../../util/output';
import error from '../../../util/output/error';
import success from '../../../util/output/success';
import getNowJsonPath from '../../../util/config/local-path';

import isURL from './is-url';
import devRouter from './dev-router';
import {
  executeBuild,
  buildUserProject,
  createIgnoreList
} from './dev-builder';

import {
  NowConfig,
  DevServerStatus,
  DevServerOptions,
  BuilderOutput,
  BuilderOutputs,
  HttpHandler,
  InvokePayload,
  InvokeResult
} from './types';

export default class DevServer {
  public cwd: string;
  public assets: BuilderOutputs;

  private output: Output;
  private debug: boolean;
  private server: http.Server;
  private status: DevServerStatus;
  private statusMessage: string = '';

  constructor(cwd: string, options: DevServerOptions) {
    this.cwd = cwd;
    this.debug = options.debug;
    this.output = options.output;
    this.assets = {};
    this.server = http.createServer(this.devServerHandler);
    this.status = DevServerStatus.busy;
  }

  /* use dev-server as a "console" for logs. */
  logDebug(...args: any[]): void {
    if (this.debug) {
      console.log(chalk.yellowBright('> [debug]'), ...args);
    }
  }

  logError(str: string): void {
    console.log(error(str));
  }

  logSuccess(str: string): void {
    console.log(success(str));
  }

  logHttp(msg: string): void {
    console.log(`  ${chalk.green('>>>')} ${msg}`);
  }

  /* set dev-server status */

  setStatusIdle(): void {
    this.status = DevServerStatus.idle;
    this.statusMessage = '';
  }

  setStatusBusy(msg: string): void {
    this.status = DevServerStatus.busy;
    this.statusMessage = msg;
  }

  setStatusError(msg: string): void {
    this.status = DevServerStatus.error;
    this.statusMessage = msg;
  }

  async getNowJson(): Promise<NowConfig | null> {
    const nowJsonPath = getNowJsonPath(this.cwd);

    try {
      const config: NowConfig = JSON.parse(
        await fs.readFile(nowJsonPath, 'utf8')
      );
      this.validateNowConfig(config);
      return config;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    return null;
  }

  validateNowConfig(config: NowConfig): void {
    if (config.version !== 2) {
      throw new Error('Only `version: 2` is supported by `now dev`');
    }
    const buildConfig = config.build || {};
    const hasSecretEnv = [
      ...Object.values(config.env || {}),
      ...Object.values(buildConfig.env || {})
    ].some(val => val[0] === '@');
    if (hasSecretEnv) {
      throw new Error('Secret env vars are not yet supported by `now dev`');
    }
  }

  /**
   * Launches the `now dev` server.
   */
  async start(port: number = 3000): Promise<void> {
    let address: string | null = null;
    const nowJson = await this.getNowJson();

    while (typeof address !== 'string') {
      try {
        address = await listen(this.server, port);
      } catch (err) {
        this.logDebug(`Got listen error: ${err.code}`);
        if (err.code === 'EADDRINUSE') {
          // Increase port and try again
          this.output.note(`Requested port ${port} is already in use`);
          port++;
        } else {
          throw err;
        }
      }
    }

    this.logSuccess(
      `${chalk.bold('`now dev`')} server listening at ${chalk.blue.underline(
        address.replace('[::]', 'localhost')
      )}`
    );

    // Perform the initial build of assets so that we know what assets exist.
    // Even though the server is running, it won't respond to any requests until
    // this is complete.
    if (nowJson && Array.isArray(nowJson.builds)) {
      this.logDebug('Initial build');
      await buildUserProject(nowJson, this);
      this.logSuccess('Initial build ready');
      this.logDebug('Built', Object.keys(this.assets));
    }

    this.setStatusIdle();
  }

  /**
   * Shuts down the `now dev` server, and cleans up any temporary resources.
   */
  async stop(): Promise<void> {
    this.logDebug('Stopping `now dev` server');
    const ops = Object.values(this.assets).map((asset: BuilderOutput) => {
      if (asset.type === 'Lambda' && asset.fn) {
        return asset.fn.destroy();
      }
    });
    ops.push(close(this.server));
    await Promise.all(ops);
  }

  shouldRebuild(req: http.IncomingMessage): boolean {
    return (
      req.headers.pragma === 'no-cache' ||
      req.headers['cache-control'] === 'no-cache'
    );
  }

  async send404(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string
  ): Promise<void> {
    return this.sendError(
      req,
      res,
      nowRequestId,
      'FILE_NOT_FOUND',
      'The page could not be found',
      404
    );
  }

  async sendError(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string,
    code: string,
    message: string,
    statusCode: number = 500
  ): Promise<void> {
    res.statusCode = statusCode;
    this.writeResponseHeaders(res, nowRequestId);
    // TODO: render an HTML page similar to Now's router
    res.end(`${statusCode}: ${message}\nCode: ${code}\n`);
  }

  getRequestIp(req: http.IncomingMessage): string {
    // TODO: respect the `x-forwarded-for` headers
    return req.connection.remoteAddress || '127.0.0.1';
  }

  /**
   * Sets the response `headers` including the Now headers to `res`.
   */
  writeResponseHeaders(
    res: http.ServerResponse,
    nowRequestId: string,
    headers: http.OutgoingHttpHeaders = {}
  ): void {
    const allHeaders = {
      ...headers,
      'x-now-trace': 'dev1',
      'x-now-id': nowRequestId,
      'x-now-cache': 'MISS'
    };
    for (const [name, value] of Object.entries(allHeaders)) {
      res.setHeader(name, value);
    }
  }

  /**
   * Returns the request `headers` that will be sent to the Lambda.
   */
  getNowProxyHeaders(
    req: http.IncomingMessage,
    nowRequestId: string,
    headers: http.IncomingHttpHeaders
  ): http.IncomingHttpHeaders {
    const ip = this.getRequestIp(req);
    const { host } = req.headers;
    return {
      ...headers,
      'X-Forwarded-Host': host,
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-For': ip,
      Connection: 'close',
      'x-now-trace': 'dev1',
      'x-now-deployment-url': host,
      'x-now-id': nowRequestId,
      'x-now-log-id': nowRequestId.split('-')[2],
      'x-zeit-co-forwarded-for': ip
    };
  }

  /**
   * dev-server http handler
   */
  devServerHandler: HttpHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => {
    this.logHttp(`${req.method} ${req.url}`);

    if (this.status === DevServerStatus.busy) {
      return res.end(`[busy] ${this.statusMessage}...`);
    }

    try {
      const nowRequestId = generateRequestId();
      const nowJson = await this.getNowJson();
      if (!nowJson) {
        await this.serveProjectAsStatic(req, res, nowRequestId);
      } else {
        await this.serveProjectAsNowV2(req, res, nowRequestId, nowJson);
      }
    } catch (err) {
      this.setStatusError(err.message);
      this.logDebug(err.stack);

      if (!res.finished) {
        res.statusCode = 500;
        res.end(this.statusMessage);
      }
    }

    this.setStatusIdle();
  };

  /**
   * Serve project directory as a static deployment.
   */
  serveProjectAsStatic = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string
  ) => {
    const filePath = req.url ? req.url.replace(/^\//, '') : '';
    const ignore = await createIgnoreList(this.cwd);

    if (filePath && ignore.ignores(filePath)) {
      await this.send404(req, res, nowRequestId);
      return;
    }

    this.writeResponseHeaders(res, nowRequestId);
    return serveStaticFile(req, res, this.cwd);
  };

  /**
   * Serve project directory as a Now v2 deployment.
   */
  serveProjectAsNowV2 = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    nowRequestId: string,
    nowJson: NowConfig
  ) => {
    const {
      dest,
      status = 200,
      headers = {},
      uri_args,
      matched_route
    } = devRouter(req.url, nowJson.routes);

    if (isURL(dest)) {
      this.logDebug('ProxyPass', matched_route);
      return proxyPass(req, res, dest);
    }

    if ([301, 302, 303].includes(status)) {
      this.logDebug('Redirect', matched_route);
      res.statusCode = status;
      return res.end(`Redirecting (${status}) to ${res.getHeader('location')}`);
    }

    if (!nowJson.builds) {
      return this.serveProjectAsStatic(req, res, nowRequestId);
    }

    // find asset responsible for dest
    let { asset, assetKey } = resolveDest(this.assets, dest);

    if (!asset || !assetKey) {
      await this.send404(req, res, nowRequestId);
      return;
    }

    // If the user did a hard-refresh in the browser,
    // then re-run the build that generated this asset
    if (this.shouldRebuild(req) && asset.buildEntry) {
      const entrypoint = relative(this.cwd, asset.buildEntry.fsPath);
      this.logDebug('Rebuilding asset:', entrypoint);
      await executeBuild(nowJson, this, asset);

      // Since the `asset` was re-built, resolve it again to get the new asset
      ({ asset, assetKey } = resolveDest(this.assets, dest));

      if (!asset || !assetKey) {
        await this.send404(req, res, nowRequestId);
        return;
      }
    }

    switch (asset.type) {
      case 'FileFsRef':
        this.writeResponseHeaders(res, nowRequestId);
        req.url = `/${basename(asset.fsPath)}`;
        return serveStaticFile(req, res, dirname(asset.fsPath));

      case 'FileBlob':
        const contentType = lookupMimeType(assetKey);
        const headers: http.OutgoingHttpHeaders = {
          'Content-Length': asset.data.length
        };
        if (contentType) {
          headers['Content-Type'] = contentType;
        }
        this.writeResponseHeaders(res, nowRequestId, headers);
        res.end(asset.data);
        return;

      case 'Lambda':
        if (!asset.fn) {
          res.statusCode = 500;
          res.end('Lambda function has not been built');
          return;
        }

        // Mix the `routes` result dest query params into the req path
        const parsed = url.parse(req.url || '/', true);
        Object.assign(parsed.query, uri_args);
        const path = url.format({
          pathname: parsed.pathname,
          query: parsed.query
        });

        const body = await rawBody(req);
        const payload: InvokePayload = {
          method: req.method || 'GET',
          path,
          headers: this.getNowProxyHeaders(req, nowRequestId, req.headers),
          encoding: 'base64',
          body: body.toString('base64')
        };

        let result: InvokeResult;
        try {
          result = await asset.fn<InvokeResult>({
            Action: 'Invoke',
            body: JSON.stringify(payload)
          });
        } catch (err) {
          console.error(err);
          await this.sendError(
            req,
            res,
            nowRequestId,
            'NO_STATUS_CODE_FROM_LAMBDA',
            'An error occurred with your deployment',
            502
          );
          return;
        }

        res.statusCode = result.statusCode;
        this.writeResponseHeaders(res, nowRequestId, result.headers);

        let resBody: Buffer | string | undefined;
        if (result.encoding === 'base64' && typeof result.body === 'string') {
          resBody = Buffer.from(result.body, 'base64');
        } else {
          resBody = result.body;
        }
        return res.end(resBody);

      default:
        // This shouldn't really ever happen...
        await this.sendError(
          req,
          res,
          nowRequestId,
          'UNKNOWN_ASSET_TYPE',
          `Don't know how to handle asset type: ${(asset as any).type}`
        );
        return;
    }
  };
}

/**
 * Mimic nginx's `proxy_pass` for routes using a URL as `dest`.
 */
function proxyPass(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dest: string
): void {
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    target: dest
  });
  return proxy.web(req, res);
}

/**
 * Handle requests for static files with serve-handler.
 */
function serveStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cwd: string
) {
  return serveHandler(req, res, {
    public: cwd,
    cleanUrls: false
  });
}

/**
 * Find the dest handler from assets.
 */
function resolveDest(
  assets: BuilderOutputs,
  dest: string
): { asset: BuilderOutput | null; assetKey: string | undefined } {
  let assetKey = dest.replace(/^\//, '');
  let asset: BuilderOutput | undefined = assets[assetKey];

  if (!asset) {
    // Find `${assetKey}/index.*` for indexes
    const indexKey = Object.keys(assets).find(name => {
      const withoutIndex = name.replace(/\/?index(\.\w+)?$/, '');
      return withoutIndex === assetKey.replace(/\/$/, '');
    });

    if (indexKey) {
      assetKey = indexKey;
      asset = assets[assetKey];
    }
  }

  return { asset, assetKey };
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Generates a (fake) Now tracing ID for an HTTP request.
 *
 * Example: lx24t-1553895116335-784edbc9ef03e2b5534f3dc6f14c90d4
 */
function generateRequestId(): string {
  return [
    Math.random()
      .toString(32)
      .slice(-5),
    Date.now(),
    randomBytes(16).toString('hex')
  ].join('-');
}
