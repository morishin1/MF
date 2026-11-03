// Opt-in owner-only review API. No Slack send path and no automatic worker schedule.
import {requireUser} from '../../lib/auth.js';
import {gwContext} from '../../lib/gw.js';
import {admin} from '../../lib/supabase.js';
import {readJson} from '../../lib/http.js';
import {askJson} from '../../lib/ai-json.js';
import {createCoachHandler} from '../../lib/behavior-coach-api.js';
export default createCoachHandler({requireUser,gwContext,getAdmin:admin,readJson,askJson});
