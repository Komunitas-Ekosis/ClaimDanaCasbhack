import path from 'path';
import { CantParseJSONFile } from './errors-ts';
import readJSONFile from './read-json-file';
import { Config } from '../types';
import { Package } from './dev/types';

interface CustomPackage extends Package {
  now?: Config;
}

export default async function readPackage(file?: string) {
  const pkgFilePath = file || path.resolve(process.cwd(), 'package.json');
  const result = await readJSONFile(pkgFilePath);

  if (result instanceof CantParseJSONFile) {
    return result;
  }

  if (result) {
    return result as CustomPackage;
  }

  return null;
}
