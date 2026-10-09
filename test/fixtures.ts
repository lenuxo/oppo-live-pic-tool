import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { test, type TestContext } from 'node:test';
export const fixtures = resolve('test/test-img');
const available = ['l1.jpg', 'l2.jpg', 's1.jpg'].every(name => existsSync(join(fixtures, name)));
export function testWithFixtures(name: string, run: (context: TestContext) => void | Promise<void>) {
  return test(name, { skip: available ? false : 'Private photo fixtures absent; see test/test-img/README.md' }, run);
}
