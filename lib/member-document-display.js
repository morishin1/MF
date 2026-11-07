// Per-member display status for the Office contract/document register.
// Never mutate gw_employees.status, account access, payroll, or time tracking.
export const DISPLAY_STATES = Object.freeze(["working","inactive","hidden"]);
export const DISPLAY_LABELS = Object.freeze({working:"稼働",inactive:"非稼働",hidden:"非表示"});
export const isDisplayState = value => DISPLAY_STATES.includes(value);
export const defaultDisplayState = employee =>
  employee?.status === "active" ? "working" : "inactive";
export const memberDisplayState = (employee,override) =>
  isDisplayState(override) ? override : defaultDisplayState(employee);
export const memberDisplayCounts = (members=[]) => {
  const counts = {working:0,inactive:0,hidden:0};
  for (const m of members) {
    const state = isDisplayState(m.displayState) ? m.displayState
      : defaultDisplayState({status:m.employeeStatus});
    counts[state]++;
  }
  return counts;
};
