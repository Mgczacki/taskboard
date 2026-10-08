// OS computer use is an optional grant made by the user when a task starts.
// Browser tools have a separate setting and are not covered by this grant.
export function dashboardComputerUseGrant(origin: string | undefined, actor: string | undefined, token: string | undefined): boolean {
  return !!origin && !actor && !token;
}
