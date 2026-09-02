import fs from 'node:fs'
const med = a => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)] }
const nat = JSON.parse(fs.readFileSync('results/stage-timings-native.json','utf8'))
const EMU_CHECK = {50:163.9,100:271.9,250:600,500:1127.5,750:1671.4,1000:2162,1500:3297.1,2000:4809.9,3000:6957.5,5000:11900.8,7500:18881.5,10000:31133.6}
const g = new Map()
for (const r of nat) { if(!g.has(r.parcels)) g.set(r.parcels,[]); g.get(r.parcels).push(r) }
const rows = [...g].sort((a,b)=>a[0]-b[0]).map(([p,rs])=>({
  parcels:p, features:rs[0].featureCount, fileKB:Math.round(rs[0].fileBytes/1024),
  parseMs:med(rs.map(r=>r.parseMs)), materialiseMs:med(rs.map(r=>r.materialiseMs)),
  indexMs:med(rs.map(r=>r.indexMs)), checkMs:med(rs.map(r=>r.checkMs)),
  postgisTotalMs:med(rs.map(r=>r.postgisTotalMs)), sizingMs:med(rs.map(r=>r.sizingMs)),
  msPerParcel:+(med(rs.map(r=>r.postgisTotalMs))/p).toFixed(3),
  emulatedCheckMs:EMU_CHECK[p]
}))
fs.writeFileSync('results/summary.json', JSON.stringify(rows,null,2))
console.log(rows.map(r=>Object.values(r).join(' | ')).join('\n'))
