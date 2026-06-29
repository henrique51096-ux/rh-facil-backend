// ============================================================
// RH Fácil — server.js
// Stack: Node.js + Express + Supabase + Multer
// ============================================================

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// CORS liberado para uso interno (file://)
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

// Supabase inicializado lazy (só quando necessário)
let supabase = null;
function getSupabase() {
  if (!supabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

const BUCKET = 'docs-rh';

// Health check — responde imediatamente
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ============================================================
// FUNCIONÁRIOS
// ============================================================

app.get('/funcionarios', async (req, res) => {
  const { status, busca } = req.query;
  const sb = getSupabase();
  let query = sb.from('funcionarios').select('*, documentos(count)').order('nome');
  if (status && status !== 'todos') query = query.eq('status', status);
  if (busca) query = query.ilike('nome', `%${busca}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/funcionarios/:id', async (req, res) => {
  const { data, error } = await getSupabase()
    .from('funcionarios').select('*, documentos(*)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Funcionário não encontrado' });
  res.json(data);
});

app.post('/funcionarios', upload.single('foto'), async (req, res) => {
  const { nome, cargo, setor, cpf, data_admissao, status, observacoes } = req.body;
  if (!nome || !cargo || !setor) return res.status(400).json({ error: 'nome, cargo e setor são obrigatórios' });
  const sb = getSupabase();
  let foto_path = null;
  if (req.file) {
    const ext = req.file.originalname.split('.').pop();
    const path = `fotos/${Date.now()}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) return res.status(500).json({ error: 'Erro ao enviar foto: ' + upErr.message });
    foto_path = path;
  }
  const { data, error } = await sb.from('funcionarios')
    .insert({ nome, cargo, setor, cpf, data_admissao, status: status || 'ativo', observacoes, foto_path })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.put('/funcionarios/:id', upload.single('foto'), async (req, res) => {
  const { nome, cargo, setor, cpf, data_admissao, status, observacoes } = req.body;
  const updates = { nome, cargo, setor, cpf, data_admissao, status, observacoes };
  const sb = getSupabase();
  if (req.file) {
    const ext = req.file.originalname.split('.').pop();
    const path = `fotos/${req.params.id}.${ext}`;
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });
    if (upErr) return res.status(500).json({ error: 'Erro ao atualizar foto: ' + upErr.message });
    updates.foto_path = path;
  }
  const { data, error } = await sb.from('funcionarios').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/funcionarios/:id', async (req, res) => {
  const sb = getSupabase();
  const { data: docs } = await sb.from('documentos').select('storage_path').eq('funcionario_id', req.params.id);
  if (docs && docs.length > 0) await sb.storage.from(BUCKET).remove(docs.map(d => d.storage_path));
  const { error } = await sb.from('funcionarios').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/funcionarios/:id/foto-url', async (req, res) => {
  const { data: func } = await getSupabase().from('funcionarios').select('foto_path').eq('id', req.params.id).single();
  if (!func?.foto_path) return res.json({ url: null });
  const { data, error } = await getSupabase().storage.from(BUCKET).createSignedUrl(func.foto_path, 3600);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.signedUrl });
});

// ============================================================
// DOCUMENTOS
// ============================================================

app.get('/funcionarios/:id/documentos', async (req, res) => {
  const { categoria } = req.query;
  let query = getSupabase().from('documentos').select('*').eq('funcionario_id', req.params.id).order('created_at', { ascending: false });
  if (categoria && categoria !== 'todos') query = query.eq('categoria', categoria);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/funcionarios/:id/documentos', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });
  const { categoria, nome_exibicao, enviado_por } = req.body;
  const funcId = req.params.id;
  const path = `${funcId}/${categoria || 'outros'}/${Date.now()}_${req.file.originalname}`;
  const sb = getSupabase();
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, req.file.buffer, { contentType: req.file.mimetype });
  if (upErr) return res.status(500).json({ error: 'Erro no upload: ' + upErr.message });
  const { data, error } = await sb.from('documentos').insert({
    funcionario_id: funcId, categoria: categoria || 'outros',
    nome_original: req.file.originalname, nome_exibicao: nome_exibicao || req.file.originalname,
    storage_path: path, tipo_mime: req.file.mimetype, tamanho_bytes: req.file.size,
    enviado_por: enviado_por || 'sistema'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.get('/documentos/:id/url', async (req, res) => {
  const { data: doc, error: docErr } = await getSupabase().from('documentos').select('storage_path, nome_original, tipo_mime').eq('id', req.params.id).single();
  if (docErr) return res.status(404).json({ error: 'Documento não encontrado' });
  const { data, error } = await getSupabase().storage.from(BUCKET).createSignedUrl(doc.storage_path, 3600);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.signedUrl, nome: doc.nome_original, mime: doc.tipo_mime });
});

app.delete('/documentos/:id', async (req, res) => {
  const sb = getSupabase();
  const { data: doc, error: docErr } = await sb.from('documentos').select('storage_path').eq('id', req.params.id).single();
  if (docErr) return res.status(404).json({ error: 'Documento não encontrado' });
  await sb.storage.from(BUCKET).remove([doc.storage_path]);
  const { error } = await sb.from('documentos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// START — porta definida antes de qualquer I/O
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`RH Fácil backend rodando na porta ${PORT}`);
});
