const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { ReminderQueueStore } = require("../src/adapters/channel/weixin/reminder-queue-store");
const { CyberbossApp } = require("../src/core/app");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"cb-reminders-"));
  t.after(() => fs.rmSync(dir,{ recursive: true, force: true }));
  const filePath = path.join(dir,"reminder-queue.json");
  const item = { id:"one",accountId:"a",senderId:"target",contextToken:"local-only",text:"synthetic",dueAtMs:Date.now()-100 };
  fs.writeFileSync(filePath,JSON.stringify({reminders:[item]}));
  return { item, store:()=>new ReminderQueueStore({filePath}) };
}
test("two independent processes retain new timers and import the former queue only once", t=>{
  const {store,item}=fixture(t), writer=store(), reader=store();
  writer.enqueue({...item,id:"other",accountId:"b"});
  reader.retryAt("one",Date.now()+60_000);
  assert.equal(store().listChecks("a",Date.now()).length,0);
  reader.finish("one");
  assert.deepEqual(store().listChecks("a",Date.now()+120_000),[]);
  assert.deepEqual(store().listDue(Date.now(),"b").map(r=>r.id),["other"]);
});
test("managed resolution keeps pending, retires chat receipts and never replays an uncertain external send", async t=>{
  const {store,item}=fixture(t);
  const sent=[];
  const app={config:{allowedUserIds:["target"]},reminderQueue:store(),
    runtimeAdapter:{resolveReminder:async()=>({status:"pending"})},
    channelAdapter:{getKnownContextTokens:()=>({target:"current-token"}),
      sendText:async delivery=>{sent.push(delivery);throw new Error("lost acknowledgement");}}};
  const sweep=()=>CyberbossApp.prototype.flushManagedReminders.call(app,{accountId:"a"});
  await sweep();
  assert.equal(sent.length,0);
  assert.equal(app.reminderQueue.listChecks("a",Date.now()+30_000).length,1);
  app.reminderQueue.retryAt("one",0);
  app.runtimeAdapter.resolveReminder=async()=>({status:"handled",via:"chat"});
  await sweep();
  assert.deepEqual(store().listChecks("a",Date.now()+30_000),[]);
  app.reminderQueue.enqueue({...item,id:"two"});
  app.runtimeAdapter.resolveReminder=async()=>({status:"deliver",text:"authored reply"});
  await sweep();
  app.reminderQueue=store(); await sweep();
  assert.deepEqual(sent,[{userId:"target",text:"authored reply",contextToken:"current-token",preserveBlock:true,deliveryId:"two"}]);
});
test("register a future timer before it is due; no real reply or unsolicited status is sent", async t=>{
  const {store,item}=fixture(t), queue=store();
  queue.finish("one"); // force the one-time import, then remove it
  const dueAtMs=Date.now()+3600_000;
  queue.enqueue({...item,id:"future",dueAtMs});
  const seen=[];
  await CyberbossApp.prototype.flushManagedReminders.call({config:{},reminderQueue:queue,
    runtimeAdapter:{async resolveReminder(r){seen.push(r.id);return {status:"pending"};}},
    deliverYukehomeProactiveMessage:()=>assert.fail("unexpected send")},{accountId:"a"});
  assert.deepEqual(seen,["future"]);
  assert.equal(queue.peekNextDueAtMs("a",true),dueAtMs);
});

test("an explicit first-chunk rejection can retry after restart, an unknown result cannot", async t=>{
  const {store}=fixture(t), queue=store();
  const app={config:{},reminderQueue:queue,runtimeAdapter:{resolveReminder:async()=>({status:"deliver",text:"authored。"})},
    channelAdapter:{getKnownContextTokens:()=>({target:"token"}),
      sendText:async()=>{throw Object.assign(new Error("rejected"),{knownNotSent:true});}}};
  await CyberbossApp.prototype.flushManagedReminders.call(app,{accountId:"a"});
  assert.deepEqual(store().listChecks("a",Date.now()+120_000).map(r=>r.id),["one"]);
  assert.deepEqual(store().listChecks("a",Date.now()),[]);
});
