const { getRequestToken, verifyHs256Jwt } = require('./realtime-protocol.cjs');
let connectionPromise;
const MAX_PENDING = 200;
let pending = 0;
const referenceKeys = ['teacherId', 'teacherID', 'teacherCode', 'userId', 'id', '_id', 'courseId', 'courseCode', 'planId', 'assignmentId', 'quizId'];
const sensitive = /password|secret|token|authorization|cookie|email|phone|address/i;

function extractMetadata(body) {
  const references = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { references, changedFields: [] };
  for (const key of referenceKeys) {
    const value = body[key];
    if (typeof value === 'string' && /^[\w@./-]{1,100}$/.test(value)) references[key] = value;
  }
  return { references, changedFields: Object.keys(body).filter(key => !sensitive.test(key) && /^[\w-]{1,60}$/.test(key)).slice(0, 60) };
}

// Tap incoming chunks without adding a data listener or putting the request into
// flowing mode. Next.js remains the sole consumer of the original request stream.
function captureMetadata(request) {
  const chunks = [];
  let bytes = 0;
  const eligible = /^application\/json\b/i.test(request.headers['content-type'] || '');
  if (!eligible) return () => ({ references: {}, changedFields: [] });
  const originalPush = request.push;
  request.push = function (chunk, encoding) {
    if (chunk !== null && bytes <= 65536) {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= 65536) chunks.push(Buffer.from(chunk));
      else chunks.length = 0;
    }
    return originalPush.call(this, chunk, encoding);
  };
  return () => {
    try { return bytes <= 65536 ? extractMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : { references: {}, changedFields: [] }; }
    catch { return { references: {}, changedFields: [] }; }
    finally { chunks.length = 0; }
  };
}

function describeAction(method, pathname) {
  const words = pathname.replace(/^\/api\//, '').replace(/^\/teacher\//, '')
    .split('/').filter(Boolean).map(part => /^[a-f\d]{24}$/i.test(part) ? 'record' : part)
    .join(' / ').replace(/[-_]/g, ' ');
  return `${method} · ${words || 'Teacher portal'}`.slice(0, 220);
}

async function database() {
  if (!connectionPromise) {
    const mongoose = require('mongoose');
    if (!process.env.MONGO_URI) throw new Error('Audit database is not configured');
    connectionPromise = mongoose.createConnection(process.env.MONGO_URI, {
      maxPoolSize: 2, serverSelectionTimeoutMS: 5000,
    }).asPromise().then(connection => connection.db).catch(error => {
      connectionPromise = null;
      throw error;
    });
  }
  return connectionPromise;
}

function attachTeacherAudit(request, response, { getDatabase = database } = {}) {
  const url = new URL(request.url, 'http://localhost');
  if (!(url.pathname.startsWith('/api/') || url.pathname.startsWith('/teacher/'))) return;
  if (url.pathname.startsWith('/api/health/') || url.pathname === '/api/auth/login') return;
  const claims = verifyHs256Jwt(getRequestToken(request), process.env.JWT_SECRET);
  if (!claims?.id && !claims?.adminId) return;
  const started = Date.now();
  const readMetadata = captureMetadata(request);
  // Keep only explicitly allowed resource identifiers, never request bodies or query text.
  const references = {};
  for (const key of referenceKeys) {
    const value = url.searchParams.get(key);
    if (value && /^[\w@./-]{1,100}$/.test(value)) references[key] = value;
  }
  let recorded = false;
  const record = async (aborted) => {
    if (recorded) return;
    recorded = true;
    if (pending >= MAX_PENDING) {
      console.error('teacher.audit.capacity: activity could not be persisted');
      return;
    }
    pending++;
    try {
      const metadata = readMetadata();
      Object.assign(references, metadata.references);
      const { Types } = require('mongoose');
      const actorId = claims.adminId || claims.id;
      if (!Types.ObjectId.isValid(actorId)) return;
      const db = await getDatabase();
      const actor = await db.collection('users').findOne({ _id: new Types.ObjectId(actorId) }, {
        projection: { name: 1, code: 1, role: 1, email: 1 },
      });
      if (!actor || !['Teacher', 'Admin'].includes(actor.role)) return;
      let teacher = actor.role === 'Teacher' ? actor : null;
      if (teacher) {
        const details = await db.collection('teachers').findOne({ $or: [{ email: actor.email || actor.code }, { teacherID: actor.code }] }, { projection: { fullName: 1, teacherID: 1 } });
        if (details) teacher = { ...actor, name: details.fullName, code: details.teacherID };
      }
      const targetId = claims.impersonatedTeacherId || references.teacherId || references.userId || (/teacher|user/i.test(url.pathname) ? references.id || references._id : null);
      if (targetId && Types.ObjectId.isValid(targetId)) {
        const candidate = await db.collection('users').findOne({ _id: new Types.ObjectId(targetId), role: 'Teacher' }, { projection: { name: 1, code: 1 } });
        if (candidate) teacher = candidate;
        else {
          const record = await db.collection('teachers').findOne({ _id: new Types.ObjectId(targetId) }, { projection: { teacherID: 1, fullName: 1, email: 1 } });
          if (record) {
            const account = await db.collection('users').findOne({ role: 'Teacher', $or: [{ code: record.teacherID }, { email: record.email }] }, { projection: { name: 1, code: 1 } });
            teacher = { _id: account?._id || record._id, name: record.fullName, code: record.teacherID };
          }
        }
      }
      if (!teacher && (references.teacherCode || references.teacherID)) {
        teacher = await db.collection('users').findOne({ code: references.teacherCode || references.teacherID, role: 'Teacher' }, { projection: { name: 1, code: 1 } });
        if (!teacher) {
          const record = await db.collection('teachers').findOne({ teacherID: references.teacherCode || references.teacherID }, { projection: { teacherID: 1, fullName: 1, email: 1 } });
          if (record) {
            const account = await db.collection('users').findOne({ email: record.email, role: 'Teacher' }, { projection: { _id: 1 } });
            teacher = { _id: account?._id || record._id, name: record.fullName, code: record.teacherID };
          }
        }
      }
      await db.collection('teacher_activity_logs').insertOne({
        actorId: String(actor._id), actorName: actor.name || actor.code,
        actorCode: actor.code, actorRole: actor.role,
        teacherId: teacher ? String(teacher._id) : null,
        teacherName: teacher?.name || teacher?.code || null, teacherCode: teacher?.code || null,
        impersonated: Boolean(claims.adminId && claims.impersonatedTeacherId),
        action: describeAction(request.method, url.pathname),
        method: request.method, pathname: url.pathname.slice(0, 350), references,
        changedFields: ['POST', 'PUT', 'PATCH'].includes(request.method) ? metadata.changedFields : [],
        statusCode: aborted ? 499 : response.statusCode,
        outcome: aborted ? 'Aborted' : response.statusCode < 400 ? 'Success' : 'Failed',
        durationMs: Date.now() - started, createdAt: new Date(started),
      });
    } catch {
      console.error('teacher.audit.persistence_failed: activity could not be persisted');
    } finally { pending--; }
  };
  response.once('finish', () => void record(false));
  response.once('close', () => { if (!response.writableFinished) void record(true); });
}

module.exports = { attachTeacherAudit, describeAction, extractMetadata, captureMetadata };
