// ============================================================
// RH Fácil — server.js
// Stack: Node.js + Express + Supabase + Multer
// Padrão: mesmo do Arquivo Fácil (single-file backend)
// ============================================================

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// ------------------------------------------------------------
// Supabase
// ------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUCKET = 'docs-rh';

// ------------------------------------------------------------
// Middlewares
// ------------------------------------------------------------
app.use(cors());
app.use(express.json());

// Health check (evita cold start longo no Render)
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ============================================================
// FUNCIONÁRIOS
// ============================================================

// GET /funcionarios — lista todos, com contagem de documentos
app.get('/funcionarios', async (req, res) => {
  const { status, busca } = req.query;

  let query = supabase
    .from('funcionarios')
    .select('*, documentos(count)')
    .order('nome');

  if (status && status !== 'todos') query = query.eq('status', status);
  if (busca) query = query.ilike('nome', `%${busca}%`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /funcionarios/:id — perfil completo com documentos
app.get('/funcionarios/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('funcionarios')
    .select('*, documentos(*)')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Funcionário não encontrado' });
  res.json(data);
});

// POST /funcionarios — cadastrar novo
app.post('/funcionarios', upload.single('foto'), async (req, res) => {
  const { nome, cargo, setor, cpf, data_admissao, status, observacoes } = req.body;

  if (!nome || !cargo || !setor) {
    return res.status(400).json({ error: 'nome, cargo e setor são obrigatórios' });
  }

  let foto_path = null;

  // Upload de foto, se enviada
  if (req.file) {
    const ext  = req.file.originalname.split('.').pop();
    const path = `fotos/${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (upErr) return res.status(500).json({ error: 'Erro ao enviar foto: ' + upErr.message });
    foto_path = path;
  }

  const { data, error } = await supabase
    .from('funcionarios')
    .insert({ nome, cargo, setor, cpf, data_admissao, status: status || 'ativo', observacoes, foto_path })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /funcionarios/:id — atualizar dados
app.put('/funcionarios/:id', upload.single('foto'), async (req, res) => {
  const { nome, cargo, setor, cpf, data_admissao, status, observacoes } = req.body;
  const updates = { nome, cargo, setor, cpf, data_admissao, status, observacoes };

  if (req.file) {
    const ext  = req.file.originalname.split('.').pop();
    const path = `fotos/${req.params.id}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: true });

    if (upErr) return res.status(500).json({ error: 'Erro ao atualizar foto: ' + upErr.message });
    updates.foto_path = path;
  }

  const { data, error } = await supabase
    .from('funcionarios')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /funcionarios/:id — remove funcionário e documentos (cascade no DB)
app.delete('/funcionarios/:id', async (req, res) => {
  // Remove arquivos do storage primeiro
  const { data: docs } = await supabase
    .from('documentos')
    .select('storage_path')
    .eq('funcionario_id', req.params.id);

  if (docs && docs.length > 0) {
    const paths = docs.map(d => d.storage_path);
    await supabase.storage.from(BUCKET).remove(paths);
  }

  const { error } = await supabase
    .from('funcionarios')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// DOCUMENTOS
// ============================================================

// GET /funcionarios/:id/documentos — lista documentos por funcionário
app.get('/funcionarios/:id/documentos', async (req, res) => {
  const { categoria } = req.query;

  let query = supabase
    .from('documentos')
    .select('*')
    .eq('funcionario_id', req.params.id)
    .order('created_at', { ascending: false });

  if (categoria && categoria !== 'todos') query = query.eq('categoria', categoria);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /funcionarios/:id/documentos — fazer upload de documento
app.post('/funcionarios/:id/documentos', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

  const { categoria, nome_exibicao, enviado_por } = req.body;
  const funcId = req.params.id;
  const ext    = req.file.originalname.split('.').pop();
  const path   = `${funcId}/${categoria || 'outros'}/${Date.now()}_${req.file.originalname}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (upErr) return res.status(500).json({ error: 'Erro no upload: ' + upErr.message });

  const { data, error } = await supabase
    .from('documentos')
    .insert({
      funcionario_id: funcId,
      categoria:      categoria || 'outros',
      nome_original:  req.file.originalname,
      nome_exibicao:  nome_exibicao || req.file.originalname,
      storage_path:   path,
      tipo_mime:      req.file.mimetype,
      tamanho_bytes:  req.file.size,
      enviado_por:    enviado_por || 'sistema'
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// GET /documentos/:id/url — gera URL assinada para visualização/download
app.get('/documentos/:id/url', async (req, res) => {
  const { data: doc, error: docErr } = await supabase
    .from('documentos')
    .select('storage_path, nome_original, tipo_mime')
    .eq('id', req.params.id)
    .single();

  if (docErr) return res.status(404).json({ error: 'Documento não encontrado' });

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, 60 * 60); // 1 hora

  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.signedUrl, nome: doc.nome_original, mime: doc.tipo_mime });
});

// DELETE /documentos/:id — remove documento e arquivo do storage
app.delete('/documentos/:id', async (req, res) => {
  const { data: doc, error: docErr } = await supabase
    .from('documentos')
    .select('storage_path')
    .eq('id', req.params.id)
    .single();

  if (docErr) return res.status(404).json({ error: 'Documento não encontrado' });

  await supabase.storage.from(BUCKET).remove([doc.storage_path]);

  const { error } = await supabase.from('documentos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ============================================================
// URL ASSINADA PARA FOTO DO FUNCIONÁRIO
// ============================================================
app.get('/funcionarios/:id/foto-url', async (req, res) => {
  const { data: func } = await supabase
    .from('funcionarios')
    .select('foto_path')
    .eq('id', req.params.id)
    .single();

  if (!func?.foto_path) return res.json({ url: null });

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(func.foto_path, 60 * 60);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ url: data.signedUrl });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RH Fácil backend rodando na porta ${PORT}`));
