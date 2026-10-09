import type { Permit } from '../api';

export function PermitSettings({ step }: { step: Permit['steps'][number] }) {
  return <>
    {step.env && <div>Nonsecret environment settings:<ul>{Object.entries(step.env).map(([name, value]) => <li key={name}><code>{name}</code>: <code>{value}</code>{step.envPaths?.[name] && step.envPaths[name] !== value && <div>Resolved path: <code>{step.envPaths[name]}</code></div>}</li>)}</ul></div>}
    {step.unsetEnv && <div>Remove from the child environment:<ul>{step.unsetEnv.map(name => <li key={name}><code>{name}</code></li>)}</ul></div>}
    {step.reviewRule && <p>Rule: <code>{step.reviewRule}</code>. Only named nonsecret settings moved to separate fields. Approval runs this exact command once.</p>}
  </>;
}
