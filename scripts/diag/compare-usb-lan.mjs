// Same unit, same settings, one sweep over USB then one over LAN; compare.
// usage: node compare-usb-lan.mjs <repo> <serial> <host>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [repo, serial, host] = process.argv.slice(2);
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const { N9340B } = await load('driver/n9340b.js');
const { UsbtmcClient } = await load('driver/usbtmc.js');
const { Vxi11Client } = await load('driver/vxi11.js');

async function run(label, transport) {
  const t0 = Date.now();
  const n = new N9340B({ transport });
  n.onFatal = (e) => console.log(`${label} FATAL`, e?.message);
  await n.connect();
  console.log(`${label} connect+IDN ${Date.now() - t0} ms:`, n.identity);
  await n.prepare();
  await n.setFrequencyRange(470e6, 617e6);
  await n.setRbw(100_000);
  await n.setVbw(null);
  await n.setRefLevel(-20);
  await n.setAttenuation(0);
  await n.setPreamp(true);
  const sweepTimeMs = await n.getSweepTimeMs();
  const errors = await n.errors();
  const times = [];
  let trace;
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    trace = await n.sweep({ sweepTimeMs });
    times.push(Date.now() - s);
  }
  await n.restoreContinuous();
  await n.close();
  console.log(`${label} sweepTime=${sweepTimeMs} ms, per sweep ${times.join(', ')} ms, errors`, errors);
  return trace;
}

const usb = await run('USB', new UsbtmcClient({ serial }));
const lan = await run('LAN', new Vxi11Client({ host }));
const diff = usb.map((v, i) => v - lan[i]);
const rms = Math.sqrt(diff.reduce((a, d) => a + d * d, 0) / diff.length);
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(`points USB ${usb.length} LAN ${lan.length}`);
console.log(`median USB ${median(usb).toFixed(2)} dBm, LAN ${median(lan).toFixed(2)} dBm`);
console.log(`max USB ${Math.max(...usb).toFixed(2)} @${usb.indexOf(Math.max(...usb))}, LAN ${Math.max(...lan).toFixed(2)} @${lan.indexOf(Math.max(...lan))}`);
console.log(`rms difference ${rms.toFixed(2)} dB (two separate sweeps: noise differs, floor and carriers should agree)`);
