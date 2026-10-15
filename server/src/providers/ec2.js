import { EC2Client, DescribeInstancesCommand, DescribeSecurityGroupsCommand, DescribeVolumesCommand, DescribeSnapshotsCommand, DescribeInstanceStatusCommand, DescribeAddressesCommand, DescribeInstanceTypesCommand, DescribeInstanceAttributeCommand } from '@aws-sdk/client-ec2';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
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
  ],
  credentialFields: [
    { key: 'accessKeyId', label: 'Access key ID', type: 'text' },
    { key: 'secretAccessKey', label: 'Secret access key (read-only IAM)', type: 'password' },
    { key: 'region', label: 'Region (e.g. ap-south-1)', type: 'text' },
  ],
  liveApi: 'AWS SDK v3: EC2 DescribeInstances + CloudWatch GetMetricData (read-only)',
};

/** Turns an AWS SDK error into a sentence that says what is wrong and what to fix. */
function explain(e) {
  const code = e?.name === 'Error' ? '' : e?.name || e?.Code || '';
  const m = String(e?.message || e);
  if (/InvalidClientTokenId|UnrecognizedClient|SignatureDoesNotMatch|AuthFailure/i.test(code + m)) return `AWS rejected the keys. Check the Access key ID and Secret access key. (${code})`;
  if (/UnauthorizedOperation|AccessDenied|not authorized/i.test(code + m)) return `This IAM user is not allowed to read EC2 or CloudWatch. Attach AmazonEC2ReadOnlyAccess and CloudWatchReadOnlyAccess. (${code})`;
  if (/Could not resolve|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED/i.test(m)) return `Could not reach AWS. Check the region code and your internet. (${m.slice(0, 100)})`;
  if (/region/i.test(m)) return `Region problem: ${m.slice(0, 120)}`;
  return `${code ? `${code}: ` : ''}${m}`.slice(0, 220);
}

/** Runs CloudWatch queries [{ id, ns, name, dim: [name, value], stat }]; returns { [id]: Map(timestamp -> value) }. */
async function metrics(cw, defs, win, period) {
  const out = {};
  const queries = defs.map((d) => ({
    Id: d.id,
    MetricStat: { Metric: { Namespace: d.ns, MetricName: d.name, Dimensions: [{ Name: d.dim[0], Value: d.dim[1] }] }, Period: period, Stat: d.stat },
    ReturnData: true,
  }));
  for (let i = 0; i < queries.length; i += 400) {
    let token;
    do {
      const r = await cw.send(new GetMetricDataCommand({ MetricDataQueries: queries.slice(i, i + 400), StartTime: new Date(win.start), EndTime: new Date(win.end), ScanBy: 'TimestampAscending', NextToken: token }));
      for (const m of r.MetricDataResults || []) {
        const o = (out[m.Id] ||= new Map());
        (m.Timestamps || []).forEach((t, j) => o.set(+t, m.Values[j]));
      }
      token = r.NextToken;
    } while (token);
  }
  return out;
}

export async function live(win, creds) {
  try {
    return await liveRaw(win, creds);
  } catch (e) {
    throw new Error(explain(e));
  }
}

const RISKY = { 22: 'SSH', 3389: 'Remote Desktop', 3306: 'MySQL', 5432: 'PostgreSQL', 27017: 'MongoDB', 6379: 'Redis', 9200: 'Elasticsearch', 5984: 'CouchDB', 11211: 'Memcached' };
const portText = (p) => (p.IpProtocol === '-1' ? 'all traffic' : p.FromPort === p.ToPort ? `${p.FromPort}` : `${p.FromPort}-${p.ToPort}`);

async function liveRaw(win, creds) {
  const accessKeyId = String(creds?.accessKeyId || '').trim();
  const secretAccessKey = String(creds?.secretAccessKey || '').trim();
  const region = String(creds?.region || '').trim();
  if (!/^[A-Z0-9]{16,40}$/.test(accessKeyId)) throw new Error('Access key ID looks wrong (it is 20 letters/numbers, e.g. AKIA…)');
  if (secretAccessKey.length < 30) throw new Error('Secret access key looks too short');
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error('Region must look like ap-south-1 or us-east-1');
  const cfg = { region, credentials: { accessKeyId, secretAccessKey } };
  const ec2 = new EC2Client(cfg);
  const cw = new CloudWatchClient(cfg);

  const all = [];
  let token;
  do {
    const r = await ec2.send(new DescribeInstancesCommand({ NextToken: token, MaxResults: 100 }));
    for (const res of r.Reservations || []) for (const i of res.Instances || []) {
      all.push({
        id: i.InstanceId, name: (i.Tags || []).find((t) => t.Key === 'Name')?.Value || i.InstanceId, type: i.InstanceType, az: i.Placement?.AvailabilityZone,
        state: i.State?.Name, launched: i.LaunchTime ? +i.LaunchTime : null, publicIp: i.PublicIpAddress || '—', privateIp: i.PrivateIpAddress || '—',
        keyName: i.KeyName || '—', imds: i.MetadataOptions?.HttpTokens === 'required', groups: (i.SecurityGroups || []).map((g) => ({ id: g.GroupId, name: g.GroupName })), volumes: (i.BlockDeviceMappings || []).map((b) => b.Ebs?.VolumeId).filter(Boolean),
      });
    }
    token = r.NextToken;
  } while (token);

  const running = all.filter((i) => i.state === 'running').slice(0, 20);
  const oldest = Math.min(...running.map((i) => i.launched || win.start));
  const from = Math.max(win.start, Number.isFinite(oldest) ? oldest : win.start);
  const span = { start: from, end: win.end };
  const period = Math.max(300, Math.ceil((span.end - span.start) / 150 / 300) * 300);

  const volIds = [...new Set(running.flatMap((i) => i.volumes))].slice(0, 10);
  const defs = [];
  running.forEach((x, i) => {
    const d = ['InstanceId', x.id];
    defs.push(
      { id: `cpu${i}`, ns: 'AWS/EC2', name: 'CPUUtilization', dim: d, stat: 'Average' },
      { id: `cpx${i}`, ns: 'AWS/EC2', name: 'CPUUtilization', dim: d, stat: 'Maximum' },
      { id: `crd${i}`, ns: 'AWS/EC2', name: 'CPUCreditBalance', dim: d, stat: 'Average' },
      { id: `out${i}`, ns: 'AWS/EC2', name: 'NetworkOut', dim: d, stat: 'Sum' },
      { id: `in${i}`, ns: 'AWS/EC2', name: 'NetworkIn', dim: d, stat: 'Sum' },
      { id: `po${i}`, ns: 'AWS/EC2', name: 'NetworkPacketsOut', dim: d, stat: 'Sum' },
      { id: `pi${i}`, ns: 'AWS/EC2', name: 'NetworkPacketsIn', dim: d, stat: 'Sum' },
      { id: `chk${i}`, ns: 'AWS/EC2', name: 'StatusCheckFailed', dim: d, stat: 'Maximum' },
      { id: `chs${i}`, ns: 'AWS/EC2', name: 'StatusCheckFailed_System', dim: d, stat: 'Maximum' },
      { id: `chi${i}`, ns: 'AWS/EC2', name: 'StatusCheckFailed_Instance', dim: d, stat: 'Maximum' },
    );
  });
  volIds.forEach((v, i) => ['VolumeReadOps', 'VolumeWriteOps', 'VolumeReadBytes', 'VolumeWriteBytes'].forEach((n, j) => defs.push({ id: `v${j}_${i}`, ns: 'AWS/EBS', name: n, dim: ['VolumeId', v], stat: 'Sum' })));
  const m = running.length ? await metrics(cw, defs, span, period) : {};

  // Same-length window just before this one, for "vs previous period" on the cards.
  const spanMs = span.end - span.start;
  const prevSpan = { start: span.start - spanMs, end: span.start };
  const prevDefs = [];
  running.forEach((x, i) => prevDefs.push({ id: `cpu${i}`, ns: 'AWS/EC2', name: 'CPUUtilization', dim: ['InstanceId', x.id], stat: 'Average' }, { id: `out${i}`, ns: 'AWS/EC2', name: 'NetworkOut', dim: ['InstanceId', x.id], stat: 'Sum' }));
  const pm = running.length && prevSpan.start > Date.now() - 60 * 864e5 ? await metrics(cw, prevDefs, prevSpan, period).catch(() => ({})) : {};
  const ts = [...new Set(Object.values(m).flatMap((o) => [...o.keys()]))].sort((a, b) => a - b);
  const get = (q, t) => m[q]?.get(t) ?? null;
  const vals = (q) => [...(m[q]?.values() || [])];
  const mean = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : 0; };
  const sumOf = (ids, t) => ids.reduce((a, q) => a + (get(q, t) || 0), 0);
  const idx = (pre, n) => Array.from({ length: n }, (_, i) => `${pre}${i}`);
  const R = idx('', running.length);
  const volQ = (j) => volIds.map((_, i) => `v${j}_${i}`);

  const cpuRows = ts.map((t) => ({ t, ...Object.fromEntries(running.map((x, i) => [x.id, +(get(`cpu${i}`, t) ?? 0).toFixed(2)])) }));
  const hasCredits = running.some((_, i) => vals(`crd${i}`).length);
  const creditRows = ts.map((t) => ({ t, ...Object.fromEntries(running.map((x, i) => [x.id, +(get(`crd${i}`, t) ?? 0).toFixed(1)])) }));
  const netRows = ts.map((t) => ({ t, out: sumOf(idx('out', R.length), t) / period, in: sumOf(idx('in', R.length), t) / period }));
  const pktRows = ts.map((t) => ({ t, out: sumOf(idx('po', R.length), t) / period, in: sumOf(idx('pi', R.length), t) / period }));
  const diskBytes = ts.map((t) => ({ t, read: sumOf(volQ(2), t) / period, write: sumOf(volQ(3), t) / period }));
  const diskOps = ts.map((t) => ({ t, read: sumOf(volQ(0), t) / period, write: sumOf(volQ(1), t) / period }));

  const cpuAvgOf = (i) => mean(vals(`cpu${i}`));
  const cpuMaxOf = (i) => Math.max(0, ...vals(`cpx${i}`));
  const avgCpu = mean(running.map((_, i) => cpuAvgOf(i)));
  const peakCpu = Math.max(0, ...running.map((_, i) => cpuMaxOf(i)));
  const netOutTotal = running.reduce((a, _, i) => a + vals(`out${i}`).reduce((x, y) => x + y, 0), 0);
  const failedNow = running.filter((_, i) => { const v = vals(`chk${i}`); return v.length && v[v.length - 1] > 0; }).length;
  const expected = Math.max(1, Math.ceil((span.end - span.start) / 1000 / period));
  const okPoints = running.reduce((a, _, i) => a + vals(`chk${i}`).filter((v) => v === 0).length, 0);
  const uptime = running.length ? Math.min(100, (okPoints / (expected * running.length)) * 100) : 0;
  const creditNow = (() => { const l = running.map((_, i) => { const v = vals(`crd${i}`); return v.length ? v[v.length - 1] : null; }).filter((v) => v != null); return l.length ? Math.min(...l) : null; })();

  // Security groups: which ports are open to the whole internet
  const groupIds = [...new Set(running.flatMap((i) => i.groups.map((g) => g.id)))];
  const sgRows = [];
  if (groupIds.length) {
    const r = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: groupIds }));
    for (const g of r.SecurityGroups || []) {
      const open = (g.IpPermissions || []).filter((p) => (p.IpRanges || []).some((x) => x.CidrIp === '0.0.0.0/0') || (p.Ipv6Ranges || []).some((x) => x.CidrIpv6 === '::/0'));
      const ports = open.map(portText);
      const risky = open.filter((p) => p.IpProtocol === '-1' || Object.keys(RISKY).some((k) => p.FromPort <= +k && +k <= p.ToPort)).length > 0;
      const used = running.filter((i) => i.groups.some((x) => x.id === g.GroupId)).map((i) => i.name).join(', ');
      sgRows.push({ group: g.GroupName, used, open: ports.length ? ports.join(', ') : 'none', risk: !ports.length ? 'ok' : risky ? 'failed' : 'warn' });
    }
  }
  const riskyGroups = sgRows.filter((r) => r.risk === 'failed').length;

  // Extra read-only lookups. A missing permission only hides that part of the page.
  const safe = (p) => p.catch(() => null);
  const [volRes, snapRes, statRes, addrRes, typeRes] = await Promise.all([
    safe(ec2.send(new DescribeVolumesCommand({ MaxResults: 500 }))),
    safe(ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ['self'], MaxResults: 1000 }))),
    safe(ec2.send(new DescribeInstanceStatusCommand({ IncludeAllInstances: false }))),
    safe(ec2.send(new DescribeAddressesCommand({}))),
    running.length ? safe(ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [...new Set(running.map((i) => i.type))] }))) : null,
  ]);
  const protect = Object.fromEntries(await Promise.all(running.map(async (i) => {
    const r = await safe(ec2.send(new DescribeInstanceAttributeCommand({ InstanceId: i.id, Attribute: 'disableApiTermination' })));
    return [i.id, r ? !!r.DisableApiTermination?.Value : null];
  })));
  const specs = Object.fromEntries((typeRes?.InstanceTypes || []).map((t) => [t.InstanceType, { cpu: t.VCpuInfo?.DefaultVCpus, ram: (t.MemoryInfo?.SizeInMiB || 0) / 1024 }]));
  const lastSnap = {};
  for (const sn of snapRes?.Snapshots || []) if (!lastSnap[sn.VolumeId] || +sn.StartTime > lastSnap[sn.VolumeId]) lastSnap[sn.VolumeId] = +sn.StartTime;
  const ago = (t) => { if (!t) return 'never'; const d = Math.floor((Date.now() - t) / 864e5); return d < 1 ? 'today' : `${d} d ago`; };
  const nameOfInst = Object.fromEntries(all.map((i) => [i.id, i.name]));
  const volRows = (volRes?.Volumes || []).map((v) => {
    const att = v.Attachments?.[0]?.InstanceId;
    return { id: v.VolumeId, size: `${v.Size} GiB`, type: v.VolumeType, state: v.State === 'in-use' ? 'running' : 'warn', att: att ? nameOfInst[att] || att : 'not attached', enc: v.Encrypted ? 'on' : 'off', backup: ago(lastSnap[v.VolumeId]), _unused: !att, _never: !lastSnap[v.VolumeId] };
  });
  const loose = volRows.filter((v) => v._unused);
  const freeIps = (addrRes?.Addresses || []).filter((a) => !a.InstanceId && !a.NetworkInterfaceId);
  const fixedIpOf = new Set((addrRes?.Addresses || []).map((a) => a.InstanceId).filter(Boolean));
  const events = (statRes?.InstanceStatuses || []).flatMap((st) => (st.Events || []).filter((e) => !/^\[Completed\]|^\[Canceled\]/.test(e.Description || '')).map((e) => ({ name: nameOfInst[st.InstanceId] || st.InstanceId, event: e.Code, note: e.Description, when: e.NotBefore ? new Date(e.NotBefore).toISOString().slice(0, 10) : '—' })));
  const attachedVols = volRows.filter((v) => !v._unused);
  const lastBackupAll = attachedVols.length ? (attachedVols.some((v) => v._never) ? 'never' : ago(Math.max(...attachedVols.map((v) => lastSnap[v.id])))) : null;
  const noBackup = attachedVols.filter((v) => v._never).length;


  // Plain-words size advice from the CPU history
  const advice = !running.length ? 'No running instances.'
    : peakCpu >= 85 ? `CPU peaked at ${peakCpu.toFixed(0)}% (average ${avgCpu.toFixed(1)}%). The server gets close to its limit; a bigger type or a second server would be safer.`
      : peakCpu < 10 && avgCpu < 5 ? `CPU is very low (average ${avgCpu.toFixed(2)}%, peak ${peakCpu.toFixed(1)}%). The server is bigger than this workload needs; the smallest type of the family is enough, and a smaller one would save money.`
        : `CPU average ${avgCpu.toFixed(1)}%, peak ${peakCpu.toFixed(0)}%. The server size looks right for the current load.`;
  const summary = !running.length ? 'No instance is running in this region.'
    : `${running.length} instance${running.length > 1 ? 's' : ''} running. ${failedNow ? `${failedNow} failing status checks.` : 'All status checks pass.'} Uptime ${uptime.toFixed(2)}%. Average CPU ${avgCpu.toFixed(2)}%, peak ${peakCpu.toFixed(1)}%. ${riskyGroups ? `${riskyGroups} security group open to the internet on a sensitive port.` : 'No sensitive ports open to the internet.'}${volRes ? ` ${noBackup ? `${noBackup} disk(s) without a backup.` : lastBackupAll ? `Last backup ${lastBackupAll}.` : ''}` : ''}${events.length ? ` ${events.length} AWS scheduled event(s).` : ''}${loose.length + freeIps.length ? ` ${loose.length + freeIps.length} unused resource(s) costing money.` : ''}`;

  const prevVals = (pre) => running.flatMap((_, i) => [...(pm[`${pre}${i}`]?.values() || [])]);
  const prevCpu = prevVals('cpu');
  const prevOut = prevVals('out').reduce((a, b) => a + b, 0);
  const pct = (cur, prev, ok) => (prev > 0 && ok ? +(((cur - prev) / prev) * 100).toFixed(1) : null);
  const k = (label, value, fmt, spark, sub, delta = null, goodWhen = null) => ({ label, value, fmt, delta, tone: delta && goodWhen ? ((delta > 0) === (goodWhen === 'up') ? 'good' : 'bad') : 'neutral', spark: spark && spark.length > 1 ? spark : null, sub, empty: false, basis: 'previous' });
  // Busiest hours of the day (UTC), by average CPU
  const byHour = {};
  cpuRows.forEach((r) => { const h = new Date(r.t).getUTCHours(); (byHour[h] ||= []).push(mean(running.map((x) => r[x.id]))); });
  const busiest = Object.entries(byHour).map(([h, v]) => ({ label: `${String(h).padStart(2, '0')}:00 – ${String((+h + 1) % 24).padStart(2, '0')}:00 UTC`, value: +mean(v).toFixed(2) })).sort((a, b) => b.value - a.value).slice(0, 5);
  const upDays = (t) => (t ? `${Math.floor((Date.now() - t) / 864e5)} d` : '—');
  const bad = failedNow || riskyGroups;

  return {
    health: { status: failedNow ? 'crit' : bad || avgCpu > 85 || noBackup || events.length ? 'warn' : 'ok', note: `${running.length} running` },
    kpis: [
      k('Running instances', running.length, 'int'),
      k('Uptime', +uptime.toFixed(2), 'pct', null, 'status checks passing'),
      k('Avg CPU', avgCpu, 'pct', cpuRows.map((r) => mean(running.map((x) => r[x.id]))), `peak ${peakCpu.toFixed(1)}%`, pct(avgCpu, mean(prevCpu), prevCpu.length), 'down'),
      k('Network out', netOutTotal, 'bytes', netRows.map((r) => r.out), undefined, pct(netOutTotal, prevOut, prevOut > 0)),
      k('Failed status checks', failedNow, 'int'),
      ...(volRes ? [k('Last backup', lastBackupAll || 'no disk', 'text', null, noBackup ? 'a disk has no backup' : 'newest snapshot')] : []),
      ...(volRes || addrRes ? [k('Unused resources', loose.length + freeIps.length, 'int', null, 'disks / IPs costing money')] : []),
      ...(creditNow != null ? [k('CPU credits left', creditNow, 'int', null, 'when 0 the server slows down')] : []),
    ],
    widgets: [
      { id: 'summary', type: 'notice', title: 'Summary', span: 12, text: summary },
      { id: 'cpu', type: 'line', title: 'CPU utilisation by instance', span: 6, unit: 'pct', series: running.map((x) => ({ key: x.id, label: x.name })), data: cpuRows },
      ...(hasCredits ? [{ id: 'credits', type: 'line', title: 'CPU credit balance', span: 6, unit: 'int', series: running.map((x) => ({ key: x.id, label: x.name })), data: creditRows }] : []),
      { id: 'net', type: 'line', title: 'Network (bytes/s)', span: 6, unit: 'bytes', series: [{ key: 'out', label: 'Out' }, { key: 'in', label: 'In' }], data: netRows },
      { id: 'pkt', type: 'line', title: 'Network packets/s', span: 6, unit: 'qps', series: [{ key: 'out', label: 'Out' }, { key: 'in', label: 'In' }], data: pktRows },
      ...(volIds.length ? [
        { id: 'dbytes', type: 'line', title: 'Disk throughput (bytes/s)', span: 6, unit: 'bytes', series: [{ key: 'read', label: 'Read' }, { key: 'write', label: 'Write' }], data: diskBytes },
        { id: 'dops', type: 'line', title: 'Disk operations/s', span: 6, unit: 'qps', series: [{ key: 'read', label: 'Read' }, { key: 'write', label: 'Write' }], data: diskOps },
      ] : []),
      {
        id: 'inst', type: 'table', title: 'Instances', span: 12,
        columns: [{ key: 'name', label: 'Name' }, { key: 'id', label: 'Instance ID' }, { key: 'type', label: 'Type' }, { key: 'az', label: 'Zone' }, { key: 'state', label: 'State', fmt: 'status' }, { key: 'up', label: 'Running for' }, { key: 'publicIp', label: 'Public IP' }, { key: 'privateIp', label: 'Private IP' }, { key: 'cpu', label: 'Avg CPU', fmt: 'pct' }],
        rows: all.map((i) => { const ri = running.findIndex((x) => x.id === i.id); return { name: i.name, id: i.id, type: i.type, az: i.az, state: i.state, up: i.state === 'running' ? upDays(i.launched) : '—', publicIp: i.publicIp, privateIp: i.privateIp, cpu: ri >= 0 ? cpuAvgOf(ri) : null }; }),
      },
      {
        id: 'sg', type: 'table', title: 'Security groups: ports open to the whole internet', span: 12,
        columns: [{ key: 'group', label: 'Group' }, { key: 'used', label: 'Used by' }, { key: 'open', label: 'Open to everyone' }, { key: 'risk', label: 'Risk', fmt: 'status' }],
        rows: sgRows,
      },
      {
        id: 'specs', type: 'table', title: 'Server specs and settings', span: 12,
        columns: [{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'cpu', label: 'vCPU' }, { key: 'ram', label: 'RAM' }, { key: 'key', label: 'Key pair' }, { key: 'imds', label: 'IMDSv2 required', fmt: 'status' }, { key: 'prot', label: 'Delete protection', fmt: 'status' }, { key: 'eip', label: 'Public IP' }],
        rows: running.map((i) => ({ name: i.name, type: i.type, cpu: specs[i.type]?.cpu ?? '—', ram: specs[i.type] ? `${specs[i.type].ram} GB` : '—', key: i.keyName, imds: i.imds ? 'on' : 'off', prot: protect[i.id] == null ? '—' : protect[i.id] ? 'on' : 'off', eip: fixedIpOf.has(i.id) ? 'fixed (Elastic IP)' : 'changes on restart' })),
      },
      ...(volRes ? [{
        id: 'disks', type: 'table', title: 'Disks and backups', span: 12,
        columns: [{ key: 'id', label: 'Volume' }, { key: 'att', label: 'Attached to' }, { key: 'size', label: 'Size' }, { key: 'type', label: 'Type' }, { key: 'enc', label: 'Encrypted', fmt: 'status' }, { key: 'backup', label: 'Last backup' }],
        rows: volRows,
      }] : []),
      ...(statRes ? [events.length
        ? { id: 'events', type: 'table', title: 'AWS scheduled events', span: 12, columns: [{ key: 'name', label: 'Server' }, { key: 'event', label: 'Event' }, { key: 'when', label: 'Date' }, { key: 'note', label: 'Details' }], rows: events }
        : { id: 'events', type: 'notice', title: 'AWS scheduled events', span: 12, text: 'No maintenance or retirement events are scheduled by AWS for your servers.' }] : []),
      ...(volRes || addrRes ? [{ id: 'waste', type: 'notice', title: 'Unused resources', span: 12, text: loose.length + freeIps.length ? `${loose.length ? `${loose.length} disk not attached to any server (${loose.map((v) => `${v.id} ${v.size}`).join(', ')}). ` : ''}${freeIps.length ? `${freeIps.length} Elastic IP not attached to any server (${freeIps.map((a) => a.PublicIp).join(', ')}). ` : ''}These cost money while doing nothing.` : 'Nothing unused: every disk and Elastic IP is attached to a server.' }] : []),
      ...(busiest.length > 1 ? [{ id: 'busy', type: 'toplist', title: 'Busiest hours of the day (average CPU)', span: 6, unit: 'pct', items: busiest }] : []),
      { id: 'size', type: 'notice', title: 'Is the server the right size?', span: 12, text: advice },
    ],
    alerts: [],
  };
}

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
