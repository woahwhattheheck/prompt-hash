import { registerHooks } from 'node:module';

// Resolve unchanged extensionless relative imports in production TS.
// Node performs its own type erasure; repository source is not rewritten.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') ||
          /\.[a-z]+$/i.test(specifier)) throw error;
      return nextResolve(specifier + '.ts', context);
    }
  },
});
