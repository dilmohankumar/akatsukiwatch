import { timeline, series, rows, sum, avg, last, kpi, toplist, ago } from '../lib/mock.js';

export const meta = {
  id: 'ec2',
  name: 'AWS EC2',
  icon: 'server',
  description: 'Instance fleet health, CPU, network, disk and spend.',
  monitors: [
    'Instance inventory: state, type, AZ, uptime',
    'CPU utilisation, CPU credit balance (burstable types)',
    'Network in/out, disk read/write ops, EBS burst balance',
    'Status checks (system + instance) failures',
    'Memory & disk % (needs CloudWatch agent)',
    'Cost by service / instance (Cost Explorer), Spot interruptions',
  ],
  credentialFields: [
    { key: 'accessKeyId', label: 'Access key ID', type: 'text' },
    { key: 'secretAccessKey', label: 'Secret access key (read-only IAM)', type: 'password' },
    { key: 'region', label: 'Region (e.g. ap-south-1)', type: 'text' },
  ],
  liveApi: 'AWS SDK v3: EC2 DescribeInstances + CloudWatch GetMetricData + Cost Explorer',
};

const fleet = [
  { id: 'i-0a1b2c3d4e5f60001', name: 'api-prod-1', type: 't3.large', az: 'ap-south-1a', base: 38 },
  { id: 'i-0a1b2c3d4e5f60002', name: 'api-prod-2', type: 't3.large', az: 'ap-south-1b', base: 34 },
  { id: 'i-0a1b2c3d4e5f60003', name: 'worker-1', type: 'c6i.xlarge', az: 'ap-south-1a', base: 55 },
  { id: 'i-0a1b2c3d4e5f60004', name: 'mongo-secondary', type: 'r6i.large', az: 'ap-south-1c', base: 22 },
];

export async function dashboard(range) {
  const tl = timeline(range);
  const cpu = {};
  fleet.forEach((f, i) => {
    cpu[f.name] = series(tl, { seed: `ec2-cpu-${i}`, base: f.base, flat: true, amp: 0.25, noise: 0.18, spike: 0.02, spikeMul: 1.9, round: false });
    cpu[f.name] = cpu[f.name].map((v) => Math.min(99, v));
  });
  const names = fleet.map((f) => f.name);
  const avgCpu = tl.ts.map((_, i) => avg(names.map((n) => cpu[n][i])));
  const netIn = series(tl, { seed: 'ec2-nin', base: 6e4, flat: true, noise: 0.3 });
  const netOut = series(tl, { seed: 'ec2-nout', base: 1.5e5, flat: true, noise: 0.3 });
  const iops = series(tl, { seed: 'ec2-iops', base: 900, flat: true, noise: 0.3, spike: 0.03, spikeMul: 2.5 });
  const burst = series(tl, { seed: 'ec2-burst', base: 94, flat: true, amp: 0.04, noise: 0.03, round: false }).map((v) => Math.min(100, v));
  const failed = series(tl, { seed: 'ec2-chk', base: 0.01, noise: 1, spike: 0.02, spikeMul: 3 }).map((v) => (v > 1 ? 1 : 0));
  const hoursInWindow = (tl.step * tl.n) / 3600e3;

  return {
    health: { status: last(avgCpu) > 85 ? 'crit' : sum(failed) ? 'warn' : 'ok', note: `${last(avgCpu).toFixed(0)}% avg CPU` },
    kpis: [
      kpi('Running instances', fleet.length, 'int', null, { sub: `${fleet.length} of ${fleet.length} healthy` }),
      kpi('Avg CPU', avg(avgCpu), 'pct', avgCpu, { mode: 'avg' }),
      kpi('Network out', sum(netOut) * (tl.step / 1000), 'bytes', netOut),
      kpi('Failed status checks', sum(failed), 'int', failed, { goodWhen: 'down' }),
      kpi('Est. cost / month', 214.6 + hoursInWindow * 0, 'usd', null, { sub: 'on-demand, 4 instances + EBS' }),
    ],
    widgets: [
      { id: 'cpu', type: 'line', title: 'CPU utilisation by instance', span: 12, unit: 'pct', series: names.map((n) => ({ key: n, label: n })), data: rows(tl, cpu) },
      { id: 'net', type: 'line', title: 'Network (bytes/s)', span: 6, unit: 'bytes', series: [{ key: 'netOut', label: 'Out' }, { key: 'netIn', label: 'In' }], data: rows(tl, { netOut, netIn }) },
      { id: 'iops', type: 'line', title: 'EBS IOPS & burst balance', span: 6, unit: 'int', series: [{ key: 'iops', label: 'IOPS' }], data: rows(tl, { iops }), note: `Burst balance now ${last(burst).toFixed(0)}%` },
      {
        id: 'inv', type: 'table', title: 'Instances', span: 12,
        columns: [{ key: 'name', label: 'Name' }, { key: 'id', label: 'Instance ID' }, { key: 'type', label: 'Type' }, { key: 'az', label: 'AZ' }, { key: 'state', label: 'State', fmt: 'status' }, { key: 'cpu', label: 'CPU', fmt: 'pct' }, { key: 'checks', label: 'Checks', fmt: 'status' }],
        rows: fleet.map((f) => ({ ...f, state: 'running', cpu: last(cpu[f.name]), checks: '2/2 passed' })),
      },
      { id: 'cost', type: 'toplist', title: 'Spend this month by service', span: 12, unit: 'usd', items: toplist('ec2-cost', ['EC2 compute', 'EBS volumes', 'Data transfer', 'CloudWatch', 'Elastic IP / NAT'], 214.6, 1.2).map((i) => ({ ...i, value: +i.value.toFixed(2) })) },
    ],
    alerts: [
      { sev: 'info', msg: 'worker-1 averaging 55% CPU — right-size review recommended in 14 days', ts: ago(2 * 3600e3) },
    ],
  };
}
