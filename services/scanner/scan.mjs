// Chooses how a job's files are scanned.
//   container  (default, required when deployed): one fresh locked-down container per job.
//   in-process (local development only): the same supplied engine and sanitizer,
//              without container resource limits. Never allowed when CLOUD_DEPLOYED=1.
import { runScanInContainer } from './launcher.mjs';

export function createScanner({ isolation = process.env.SCANNER_ISOLATION ?? 'container', ...launcherOptions } = {}) {
  if (isolation === 'container') {
    return { isolation, scan: (files, { signal } = {}) => runScanInContainer({ files }, { ...launcherOptions, signal }) };
  }
  if (isolation === 'in-process') {
    if (process.env.CLOUD_DEPLOYED === '1') throw new Error('In-process scanning is not allowed in a deployment.');
    return {
      isolation,
      async scan(files) {
        const { runJob } = await import('./runner.mjs');
        try { return runJob({ files }); }
        catch (error) { return { schemaVersion: '1', status: 'ERROR', error: { code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR' } }; }
      }
    };
  }
  throw new Error('SCANNER_ISOLATION must be container or in-process.');
}
