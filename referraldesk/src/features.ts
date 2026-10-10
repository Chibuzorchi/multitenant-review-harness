import type { NextFunction, Request, Response } from 'express';
import { getSetting, setSetting } from './db';

export function patientModuleEnabled(): boolean {
  return getSetting('patient_module_enabled', 'false') === 'true';
}

export function setPatientModule(enabled: boolean): void {
  setSetting('patient_module_enabled', String(enabled));
}

/** Guards every patient route. Evaluated per request, so a flag change takes effect immediately. */
export function requirePatientModule(_req: Request, res: Response, next: NextFunction): void {
  if (!patientModuleEnabled()) {
    res.status(403).json({ error: 'FEATURE_DISABLED', feature: 'patient_module' });
    return;
  }
  next();
}
