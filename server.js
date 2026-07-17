import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { encoding_for_model } from 'tiktoken';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const encoder = encoding_for_model('gpt-3.5-turbo');

app.use(cors());
app.use(express.json());

// ========== 工具函数 ==========

function countTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += encoder.encode(msg.content).length;
    if (msg.reasoning_content) {
      total += encoder.encode(msg.reasoning_content).length;
    }
  }
  return total;
}

async function buildContext(sessionId, settings) {
  const context = [];
  
  context.push({
    role: 'system',
    content: settings.system_prompt
  });
  
  const { data: memories } = await supabase
    .from('memories')
    .select('*')
    .eq('session_id', 'global')
    .order('timestamp', { ascending: true });
  
  if (memories && memories.length > 0) {
    const memorySummary = memories.map(m => m.summary).join('\n\n');
    context.push({
      role: 'system',
      content: `以下是之前对话的摘要记忆：\n${memorySummary}`
    });
  }
  
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true })
    .limit(settings.max_context_rounds * 2);
  
  if (messages) {
    for (const msg of messages) {
      context.push({
        role: msg.role,
        content: msg.content
      });
    }
  }
  
  return context;
}

async function compressMemory(sessionId, settings, apiConfig) {
  const { data: oldMessages } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true })
    .limit(settings.compress_keep_rounds * 2);
  
  if (!oldMessages || oldMessages.length === 0) return;
  
  const contentToCompress = oldMessages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');
  
  try {
    // 使用用户配置的 API，选择便宜的模型压缩
    const response = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat', // 用便宜的模型压缩
        messages: [
          {
            role: 'system',
            content: '请将以下对话内容压缩成一段简短的摘要，保留关键信息和上下文。'
          },
          {
            role: 'user',
            content: contentToCompress
          }
        ]
      })
    });
    
    const data = await response.json();
    const summary = data.choices[0].message.content;
    
    await supabase
      .from('memories')
      .insert({
        session_id: 'global',
        summary: summary,
        conversation_id: `session_${sessionId}_${Date.now()}`
      });
    
    const oldMessageIds = oldMessages.map(m => m.id);
    await supabase
      .from('messages')
      .update({ visible: false })
      .in('id', oldMessageIds);
    
    console.log(`压缩了 ${oldMessages.length} 条消息`);
  } catch (error) {
    console.error('压缩记忆失败:', error);
  }
}

async function callAI(messages, model, apiConfig) {
  if (model.startsWith('claude')) {
    // Anthropic 格式
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role !== 'system');
    
    const response = await fetch(`${apiConfig.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiConfig.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 4096,
        messages: userMsgs,
        system: systemMsg?.content
      })
    });
    
    const data = await response.json();
    return data.content[0].text;
  } else {
    // OpenAI 格式
    const response = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages
      })
    });
    
    const data = await response.json();
    return data.choices[0].message.content;
  }
}

// ========== API 路由 ==========

app.get('/health', async (req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .limit(1);
  
  res.json({ 
    status: 'ok', 
    database: error ? 'disconnected' : 'connected',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { name = '新对话' } = req.body;
    
    const { data, error } = await supabase
      .from('sessions')
      .insert({ name })
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('创建会话失败:', error);
    res.status(500).json({ error: '创建会话失败' });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('获取会话列表失败:', error);
    res.status(500).json({ error: '获取会话列表失败' });
  }
});

app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    const { data, error } = await supabase
      .from('sessions')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('重命名会话失败:', error);
    res.status(500).json({ error: '重命名会话失败' });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('删除会话失败:', error);
    res.status(500).json({ error: '删除会话失败' });
  }
});

app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('session_id', id)
      .eq('visible', true)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('获取消息失败:', error);
    res.status(500).json({ error: '获取消息失败' });
  }
});

app.post('/api/sessions/:id/chat', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, apiConfig } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: '消息不能为空' });
    }
    
    await supabase
      .from('messages')
      .insert({
        session_id: id,
        role: 'user',
        content: message
      });
    
    await supabase
      .from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);
    
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();
    
    let context = await buildContext(id, settings);
    
    context.push({
      role: 'user',
      content: message
    });
    
    const tokenCount = countTokens(context);
    console.log(`当前 token 数: ${tokenCount}`);
    
    if (tokenCount > settings.compress_threshold) {
      console.log('触发记忆压缩...');
      await compressMemory(id, settings, apiConfig);
      context = await buildContext(id, settings);
      context.push({
        role: 'user',
        content: message
      });
    }
    
    const reply = await callAI(context, apiConfig.model, apiConfig);
    
    await supabase
      .from('messages')
      .insert({
        session_id: id,
        role: 'assistant',
        content: reply
      });
    
    res.json({ reply });
  } catch (error) {
    console.error('对话失败:', error);
    res.status(500).json({ error: '对话失败' });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('获取设置失败:', error);
    res.status(500).json({ error: '获取设置失败' });
  }
});

app.patch('/api/settings', async (req, res) => {
  try {
    const updates = req.body;
    
    const { data, error } = await supabase
      .from('settings')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('session_id', 'global')
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('更新设置失败:', error);
    res.status(500).json({ error: '更新设置失败' });
  }
});

app.post('/chat', async (req, res) => {
  res.status(410).json({ 
    error: '此接口已废弃，请使用 /api/sessions/:id/chat' 
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
