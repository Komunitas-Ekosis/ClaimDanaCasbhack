import type { BoundChildProcess } from './types';

const PROMPT_TIMEOUT = 3000;

export default async function waitForPrompt(
  cp: BoundChildProcess,
  rawAssertion: string | RegExp | ((chunk: string) => boolean)
) {
  let assertion: (chunk: string) => boolean;
  if (typeof rawAssertion === 'string') {
    assertion = (chunk: string) => chunk.includes(rawAssertion);
    console.log(assertion);
  } else if (rawAssertion instanceof RegExp) {
    assertion = (chunk: string) => rawAssertion.test(chunk);
  } else {
    assertion = rawAssertion;
  }

  new Promise<void>((resolve, reject) => {
    console.log('Waiting for prompt...');
    const handleTimeout = setTimeout(
      () =>
        reject(
          new Error(
            `timed out after ${PROMPT_TIMEOUT}ms in waitForPrompt, waiting for: ${rawAssertion.toString()}`
          )
        ),
      PROMPT_TIMEOUT
    );
    const listener = (chunk: string) => {
      console.log('> ' + chunk);
      if (assertion(chunk)) {
        cp.stdout.off && cp.stdout.off('data', listener);
        cp.stderr.off && cp.stderr.off('data', listener);
        clearTimeout(handleTimeout);
        resolve();
      }
    };

    cp.stdout.on('data', listener);
    cp.stderr.on('data', listener);
  });
}
