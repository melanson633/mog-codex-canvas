import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkbook } from '@mog-sdk/sdk/node';
import { createFinancialLab } from './financial-lab.ts';
import { revisionOf } from './workbook-revision.ts';
async function setup(label = 'Sales', formula = '=B2*B3-B4') {
 const w = await createWorkbook();
 try { const s = w.activeSheet; await s.setRange('A1:B5', [[label,'Value'],['Units',100],['Price',20],['Cost',500],['Profit',formula]]); await s.calculate(true); const bytes = await w.toXlsx(); return { bytes, sheet:w.sheetNames[0], lab:createFinancialLab({read:async()=>({bytes,revision:revisionOf(bytes)})}) }; } finally { await w.dispose(); }
}
test('decision analyses compute joint cases, ranked drivers and a residual-verified target without changing source', async()=>{
 const {lab,bytes,sheet}=await setup(); const original=Buffer.from(bytes);
 const grid=await lab.sensitivity('x.xlsx',{sheet,rowInput:'B2',rowValues:[80,100],colInput:'B3',colValues:[15,20],output:'B5'});
 assert.deepEqual(grid.matrix,[[700,1100],[1000,1500]]);
 const drivers=await lab.drivers('x.xlsx',{sheet,inputs:[{cell:'B2',low:80,high:120},{cell:'B3',low:19,high:21}],output:'B5'});
 assert.equal(drivers.baseline,1500); assert.equal(drivers.drivers[0].cell,'B2'); assert.equal(drivers.drivers[0].span,800);
 const goal=await lab.goalSeek('x.xlsx',{sheet,input:'B2',output:'B5',target:2500,lower:100,upper:200});
 assert.equal(goal.status,'converged'); assert.equal(goal.solution,150); assert.ok(Math.abs(goal.residual)<=goal.tolerance);
 assert.deepEqual(Buffer.from(bytes),original);
});
test('decision boundaries reject malformed, duplicate, stale and protected requests',async()=>{
 const {lab,sheet}=await setup();
 await assert.rejects(lab.sensitivity('x',{sheet,rowInput:' B002:B2 ',rowValues:[1],colInput:'$B$2',colValues:[2],output:'B5'}),/distinct/);
 await assert.rejects(lab.sensitivity('x',{sheet,rowInput:'b2',rowValues:[1],colInput:'$B$2',colValues:[2],output:'B5'}),/distinct/);
 await assert.rejects(lab.drivers('x',{sheet,inputs:[{cell:'B2',low:NaN,high:5}],output:'B5'}),/finite/);
 await assert.rejects(lab.drivers('x',{sheet,inputs:[{cell:'b2',low:1,high:2},{cell:'$B$2',low:2,high:3}],output:'B5'}),/distinct/);
 await assert.rejects(lab.goalSeek('x',{sheet,input:'B2',output:'B5',target:0,lower:100,upper:200}),/bracket/);
 await assert.rejects(lab.goalSeek('x',{sheet,input:'B2',output:'B5',target:2500,lower:100,upper:200,expectedRevision:'old'}),/revision/);
 const protectedModel=await setup('Employee_DOB');
 await assert.rejects(protectedModel.lab.drivers('x',{sheet:protectedModel.sheet,inputs:[{cell:'B2',low:1,high:2}],output:'B5'}),/redacted/);
});
test('discontinuous target never falsely converges based on a narrow bracket',async()=>{
 const {lab,sheet}=await setup('Sales','=IF(B2<1,0,10)');
 const r=await lab.goalSeek('x',{sheet,input:'B2',output:'B5',target:5,lower:0,upper:2,tolerance:0.001});
 assert.equal(r.status,'not-converged'); assert.equal(Math.abs(r.residual),5); assert.ok(r.iterations<=40);
});
test('decision methods share the calculation lock and reject a revision changed during calculation',async()=>{
 const {bytes,sheet,lab}=await setup();
 const req={sheet,input:'B2',output:'B5',target:2500,lower:100,upper:200};
 const first=lab.goalSeek('x',req);
 await assert.rejects(lab.sensitivity('x',{sheet,rowInput:'B2',rowValues:[90],colInput:'B3',colValues:[20],output:'B5'}),/already calculating/);
 await first;
 let reads=0;
 const changing=createFinancialLab({read:async()=>({bytes,revision:++reads===1?'one':'two'})});
 await assert.rejects(changing.goalSeek('x',req),/source changed/);
});
test('public methods enforce their bounds before an engine starts',async()=>{
 const {lab,sheet}=await setup();
 await assert.rejects(lab.sensitivity('x',{sheet,rowInput:'B2',rowValues:[1,2,3,4,5,6],colInput:'B3',colValues:[1],output:'B5'}),/1 to 5/);
 await assert.rejects(lab.drivers('x',{sheet,inputs:[],output:'B5'}),/1 to 6/);
 await assert.rejects(lab.drivers('x',{sheet,inputs:[{cell:'B5',low:1,high:2}],output:'B5'}),/numeric constant/);
 await assert.rejects(lab.goalSeek('x',{sheet,input:'B2',output:'B5',target:NaN,lower:0,upper:1}),/finite/);
 await assert.rejects(lab.goalSeek('x',{sheet,input:'B2',output:'B5',target:1,lower:0,upper:1,tolerance:0}),/positive tolerance/);
 await assert.rejects(lab.goalSeek('x',{sheet,input:'B2',output:'B5',target:1,lower:1,upper:0}),/increasing bracket/);
 const unsupported=await setup('Sales','=RAND()');
 await assert.rejects(unsupported.lab.goalSeek('x',{sheet:unsupported.sheet,input:'B2',output:'B5',target:1,lower:0,upper:2}),/unsupported formulas/);
});
