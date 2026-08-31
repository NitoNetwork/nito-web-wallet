process.env.HOST ??= '127.0.0.1';
process.env.PORT ??= '3000';
process.env.NODE_ENV = 'production';

await import('../dist/standalone/server.js');
