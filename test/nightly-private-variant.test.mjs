import test from 'node:test';
import assert from 'node:assert/strict';
import nightlyModule from '../src/nightly-default.ts';
import {experimentReceipts} from '../src/improvement-report.ts';
const nightly=nightlyModule.default??nightlyModule;
test('private product changes are not forced upstream and source changes need independent external review',()=>{
 const text=nightly.prompt({maxTurns:20,startHour:23,endHour:5,timezone:'UTC'},1);
 for(const expected of ['Zielwahl statt Upstream-Zwang','Nicht-Upstream-Repo','Core, WebUI oder Plugin-Sources','unabhängigen externen Review','Selbstreview, grüne Tests oder ein anderer Merge-Login allein reichen nicht','0 verpflichtenden Approvals'])assert.ok(text.includes(expected));
});
test('private variant delivery is persisted as a distinct destination, not relabeled upstream',()=>{
 const r={execution:'performed',hypothesis:'private fixture',baseline:'measured baseline',candidate:'tested candidate',evidence:'fixture passed',outcome:'improved',delivery:{stream:'variant',status:'pushed',repository:'https://git.vanillacore.net/harness/agent-fixture',branch:'variants/fixture',commit:'a'.repeat(40)}};
 assert.deepEqual(experimentReceipts('```improvement-experiment\n'+JSON.stringify(r)+'\n```'),[r]);
});
