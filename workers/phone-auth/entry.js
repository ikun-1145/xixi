// Alias resolved only by scripts/build-phone-auth-worker.mjs. The authoritative
// email/auth Worker stays in its existing repository and is never copied here.
import existingWorker, * as hooks from 'sunland-existing-auth-worker';
import { createPhoneAuthWorker } from './routes.js';
export { PhoneAuthCoordinator } from './coordinator.js';
export default createPhoneAuthWorker(existingWorker, hooks);
