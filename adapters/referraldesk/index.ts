import type { Target } from '../index';
import { api } from './api';
import { auth } from './auth';
import { control } from './control';
import { database } from './database';
import { jobs } from './jobs';
import { logs } from './logs';
import { outbound } from './outbound';

/** Adapter set for ReferralDesk, the fictional stand-in application shipped with this repository. */
export const referraldesk: Target = { name: 'ReferralDesk', auth, api, database, logs, jobs, outbound, control };
