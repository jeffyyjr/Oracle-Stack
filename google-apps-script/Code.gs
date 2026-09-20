const ORACLE_INBOUND_URL = 'https://oracle-stack.onrender.com/api/sales/inbound';
const TRACK_LABEL = 'OracleStack/Tracked';

function doGet() {
  return json_({ ok: true, service: 'oracle-gmail-bridge' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const secret = PropertiesService.getScriptProperties().getProperty('ORACLE_BRIDGE_SECRET');
    if (!secret || body.secret !== secret) return json_({ ok:false, error:'unauthorized' });

    if (body.action === 'send') {
      const to = String(body.to || '').trim();
      const subject = String(body.subject || '').trim();
      const text = String(body.text || '').trim();
      if (!to || !subject || !text) return json_({ ok:false, error:'missing_fields' });

      const draft = GmailApp.createDraft(to, subject, text);
      const sent = draft.send();
      const thread = sent.getThread();
      const label = getOrCreateLabel_(TRACK_LABEL);
      thread.addLabel(label);
      PropertiesService.getScriptProperties().setProperty('lead:' + thread.getId(), String(body.oracleLeadId || ''));
      PropertiesService.getScriptProperties().setProperty('count:' + thread.getId(), String(thread.getMessageCount()));
      return json_({ ok:true, messageId:sent.getId(), threadId:thread.getId() });
    }

    if (body.action === 'sync') {
      const result = syncReplies_();
      return json_({ ok:true, ...result });
    }

    return json_({ ok:false, error:'unknown_action' });
  } catch (err) {
    return json_({ ok:false, error:String(err && err.message || err) });
  }
}

function syncReplies_() {
  const secret = PropertiesService.getScriptProperties().getProperty('ORACLE_INBOUND_SECRET');
  if (!secret) throw new Error('ORACLE_INBOUND_SECRET is missing');
  const label = getOrCreateLabel_(TRACK_LABEL);
  const threads = label.getThreads(0, 100);
  let forwarded = 0;

  threads.forEach(thread => {
    const threadId = thread.getId();
    const messages = thread.getMessages();
    const key = 'count:' + threadId;
    const previous = Number(PropertiesService.getScriptProperties().getProperty(key) || 0);
    if (messages.length <= previous) return;

    for (let i = previous; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.isDraft()) continue;
      if (msg.getFrom().indexOf(Session.getActiveUser().getEmail()) !== -1) continue;

      const payload = JSON.stringify({
        inReplyTo: threadId,
        messageId: msg.getId(),
        text: msg.getPlainBody().slice(0, 8000),
        from: msg.getFrom(),
        subject: msg.getSubject()
      });
      const sigBytes = Utilities.computeHmacSha256Signature(payload, secret);
      const signature = sigBytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
      UrlFetchApp.fetch(ORACLE_INBOUND_URL, {
        method:'post',
        contentType:'application/json',
        payload,
        headers:{ 'X-Oracle-Signature':'sha256=' + signature },
        muteHttpExceptions:true
      });
      forwarded++;
    }
    PropertiesService.getScriptProperties().setProperty(key, String(messages.length));
  });

  return { forwarded };
}

function installReplyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncReplies_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncReplies_').timeBased().everyMinutes(1).create();
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
