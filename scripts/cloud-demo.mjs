process.env.SCANNER_PORT = process.env.CLOUD_API_PORT ?? '3200';
await import('./api-demo.mjs');
