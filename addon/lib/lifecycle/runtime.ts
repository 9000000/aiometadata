import { createReadinessRegistry } from './readiness';
import { createShutdownSequence } from './shutdown';

export const readiness = createReadinessRegistry();
export const shutdownSequence = createShutdownSequence();
