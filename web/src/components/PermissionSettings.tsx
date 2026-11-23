import { MARIO_PERMISSIONS, PERMISSION_TYPES, manualReason, type PermissionAutoApprove } from '../../../shared/permission-policy';
import { SettingGroup, SettingItem } from './SettingsLayout';

export function PermissionSettings({ values, busy, save }: {
  values?: PermissionAutoApprove;
  busy: boolean;
  save: (patch: { permissionAutoApprove: Partial<PermissionAutoApprove> }) => Promise<void>;
}) {
  return <SettingGroup section="permissions" id="permissionTypes" help="Changes apply to new requests. Cards already waiting stay manual. Actions already running finish normally.">
      <SettingItem id="permissionPreset">
        <p className="sub">All types start manual. Existing direct permissions and urgent mode remain separate settings. Manual here does not revoke them. Types marked always manual stay manual in every mode.</p>
        <button className="btn" disabled={busy || !values} onClick={() => void save({ permissionAutoApprove: MARIO_PERMISSIONS })}>Use Mario’s starting choices</button>
        <ul className="sub">
          <li>Auto-approve pushes.</li>
          <li>Auto-approve task creation.</li>
          <li>Auto-approve command permits.</li>
          <li>Auto-approve messages between agents.</li>
          <li>Keep all other types manual, including A2A mail.</li>
        </ul>
      </SettingItem>
      {PERMISSION_TYPES.map(row => {
        const reason = manualReason(row.id);
        return <SettingItem key={row.id} id={`permission-${row.id}`}>
          <label className="opt" htmlFor={`permission-${row.id}`}>
            {row.label}
            <select id={`permission-${row.id}`} disabled={busy || !values || !!reason} value={values?.[row.id] && !reason ? 'auto' : 'manual'}
              onChange={e => void save({ permissionAutoApprove: { [row.id]: e.target.value === 'auto' } })}>
              <option value="manual">{reason ? 'Always manual' : 'Manual'}</option>
              {!reason && <option value="auto">Auto-approve</option>}
            </select>
          </label>
          <div className="sub"><code>{row.id}</code>{reason ? ` · ${reason}` : 'note' in row ? ` · ${row.note}` : ''}</div>
        </SettingItem>;
      })}
    </SettingGroup>;
}
