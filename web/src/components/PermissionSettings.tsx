import { PERMISSION_TYPES, type PermissionAutoApprove } from '../../../shared/permission-policy';
import { SettingGroup, useSettingsFilter } from './SettingsLayout';

// One table row for each permission type. Every type starts manual. The search box hides the rows it does not match.
export function PermissionSettings({ values, busy, save }: {
  values?: PermissionAutoApprove;
  busy: boolean;
  save: (patch: { permissionAutoApprove: Partial<PermissionAutoApprove> }) => Promise<void>;
}) {
  const f = useSettingsFilter();
  return <SettingGroup section="permissions" id="permissionTypes" help="Every type starts manual. Changes apply to new requests. Cards already waiting stay manual. Direct permissions and urgent mode are separate settings.">
    <table className="procs-table perm-table">
      <thead><tr><th>Type</th><th>Approval</th><th>Notes</th></tr></thead>
      <tbody>
        {PERMISSION_TYPES.map(row => <tr key={row.id} data-setting={`permission-${row.id}`} hidden={!!f && !f.shows(`permission-${row.id}`)}>
          <td><label htmlFor={`permission-${row.id}`}>{row.label}</label></td>
          <td>
            <select id={`permission-${row.id}`} disabled={busy || !values} value={values?.[row.id] ? 'auto' : 'manual'}
              onChange={e => void save({ permissionAutoApprove: { [row.id]: e.target.value === 'auto' } })}>
              <option value="manual">Manual</option>
              <option value="auto">Auto-approve</option>
            </select>
          </td>
          <td className="sub"><code>{row.id}</code>{'note' in row ? ` · ${row.note}` : ''}</td>
        </tr>)}
      </tbody>
    </table>
  </SettingGroup>;
}
