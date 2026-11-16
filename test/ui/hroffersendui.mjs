// 現行運用：HRは合格通知PDFの登録まで。旧フォーム作成／電子契約の期待を置換。
// PDF生成・明示送付の互換性は hrpdfflowui/API 試験、Office契約保管は officesimpledocsui で継続検証。
import {runUploadChecks} from '../_hr-current-documents.js';
await runUploadChecks([{width:1440,key:'reviewOffer',kind:'offer',label:'オファーPDFをアップロード',offerType:'contractor'},{width:390,key:'reviewOffer',kind:'offer',label:'合格通知PDFをアップロード'}]);
console.log('PASS current HR notice upload: applicant/kind binding, file bytes, no send/publish, role and responsive guards');
