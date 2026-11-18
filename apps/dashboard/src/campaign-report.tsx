import { useState } from 'react';
import { CheckCheck, MousePointer2, Radio, Users } from 'lucide-react';
import { stateLabel, timeLabel, type CampaignReport as Report } from './admin-model';

export function CampaignReport({ report }: { report: Report }) {
  const [issuesOnly, setIssuesOnly] = useState(false);
  const metrics = [
    { label: 'Targeted browsers', value: report.metrics.targeted, icon: Users, hint: 'Audience saved at activation' },
    { label: 'Provider accepted', value: report.metrics.accepted, icon: CheckCheck, hint: 'Accepted by the push service' },
    { label: 'Browser receipts', value: report.metrics.received, icon: Radio, hint: 'Reported after notification creation' },
    { label: 'Notification clicks', value: report.metrics.clicked, icon: MousePointer2, hint: 'Reported notification interactions' },
  ];
  const rows = report.deliveries.filter(row => !issuesOnly || ['failed', 'expired'].includes(row.state));
  return <section className="campaign-report" aria-label="Campaign analytics"><div className="metric-grid">{metrics.map(({ label, value, icon: Icon, hint }) => <div className="metric-card" key={label}><span><Icon size={16}/>{label}</span><strong>{value}</strong><small>{hint}</small></div>)}</div>
    <p className="observation-note">Acceptance, receipts, and clicks are separate observations. Browser reports are best effort; a missing report does not prove delivery failed or that a person did not see the notification.</p>
    <div className="delivery-breakdown"><div className="section-row"><h3>Delivery outcomes</h3><span>{report.dispatchedCount} / {report.recipientCount} dispatched</span></div>
      <div className="outcome-bar" role="img" aria-label={Object.entries(report.counts).map(([state, count]) => `${stateLabel(state)}: ${count}`).join(', ') || 'No deliveries'}>{Object.entries(report.counts).map(([state, count]) => <span key={state} className={`outcome-${state}`} style={{ flex: count }} title={`${stateLabel(state)}: ${count}`}/>)}</div>
      <div className="outcome-legend">{Object.entries(report.counts).map(([state, count]) => <span key={state}><i className={`outcome-${state}`}/>{stateLabel(state)}<strong>{count}</strong></span>)}</div>
    </div><div className="section-row report-table-heading"><h3>Delivery details</h3><label className="checkbox-label"><input type="checkbox" checked={issuesOnly} onChange={event => setIssuesOnly(event.target.checked)}/>Failed or expired only</label></div>
    <div className="table-scroll"><table className="delivery-table"><caption className="sr-only">Delivery outcomes, attempts, and browser observations</caption><thead><tr><th>Browser</th><th>Outcome</th><th>Attempts</th><th>Provider</th><th>Receipt</th><th>Click</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><code>{row.subscriptionId.slice(0, 12)}</code>{row.updatedAt && <small>{timeLabel(row.updatedAt)}</small>}</td><td><span className={`campaign-state state-${row.state}`}>{stateLabel(row.state)}</span>{row.reason && <small>{stateLabel(row.reason)}</small>}{row.state === 'pending' && row.nextAttemptAt && <small>Next attempt: {timeLabel(row.nextAttemptAt)}</small>}</td><td>{row.attempts}</td><td>{row.providerStatus ?? '—'}</td><td>{timeLabel(row.receivedAt)}</td><td>{timeLabel(row.clickedAt)}</td></tr>)}</tbody></table></div>
    {!rows.length && <p className="empty-inline">{issuesOnly ? 'No failed or expired deliveries in this campaign.' : 'No delivery records yet.'}</p>}<p className="report-updated">Report refreshed {timeLabel(report.reportedAt)}. Active campaign reports refresh every 10 seconds.</p>
  </section>;
}
