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
app.use(express.json({ limit: '10mb' }));

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

async function buildContext(sessionId, settings, sessionConfig) {
  const context = [];
  
  // 1. 系统提示词
  let systemPrompt = settings.system_prompt;
  
  // 2. 添加会话特定设定
  if (sessionConfig) {
    if (sessionConfig.character_setting) {
      systemPrompt += `\n\n角色设定：\n${sessionConfig.character_setting}`;
    }
    if (sessionConfig.user_setting) {
      systemPrompt += `\n\n用户设定：\n${sessionConfig.user_setting}`;
    }
    
    // 3. 添加世界书
    const { data: worldBook } = await supabase
      .from('world_book')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    
    if (worldBook && worldBook.length > 0) {
      systemPrompt += '\n\n世界观设定：';
      worldBook.forEach(entry => {
        systemPrompt += `\n${entry.name}：${entry.content}`;
      });
    }
    
    // 4. 时间感知
    if (sessionConfig.time_awareness) {
      const now = new Date();
      systemPrompt += `\n\n当前时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    }
  }
  
  context.push({
    role: 'system',
    content: systemPrompt
  });
  
  // 5. 加载记忆总结
  const { data: memorySummaries } = await supabase
    .from('memory_summaries')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  
  if (memorySummaries && memorySummaries.length > 0) {
    const summaryText = memorySummaries.map(m => m.summary).join('\n\n');
    context.push({
      role: 'system',
      content: `以下是之前对话的总结记忆：\n${summaryText}`
    });
  }
  
  // 6. 加载历史消息
  let messageQuery = supabase
    .from('messages')
    .select('*')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: false });
  
  // 应用记忆条数限制
  if (sessionConfig && sessionConfig.memory_count) {
    messageQuery = messageQuery.limit(sessionConfig.memory_count);
  } else {
    messageQuery = messageQuery.limit(settings.max_context_rounds * 2);
  }
  
  const { data: messages } = await messageQuery;
  
  if (messages) {
    messages.reverse().forEach(msg => {
      context.push({
        role: msg.role,
        content: msg.content
      });
    });
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
    const response = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
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

// 创建新会话
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

// 获取会话列表
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

// 获取单个会话详情（包含所有配置）
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('获取会话详情失败:', error);
    res.status(500).json({ error: '获取会话详情失败' });
  }
});

// 更新会话（包含所有配置）
app.patch('/api/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const { data, error } = await supabase
      .from('sessions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('更新会话失败:', error);
    res.status(500).json({ error: '更新会话失败' });
  }
});

// 删除会话
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

// 清除会话所有消息
app.delete('/api/sessions/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('messages')
      .delete()
      .eq('session_id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('清除消息失败:', error);
    res.status(500).json({ error: '清除消息失败' });
  }
});

// 获取会话消息
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

// 核心对话接口
app.post('/api/sessions/:id/chat', async (req, res) => {
  try {
    const { id } = req.params;
    const { message, apiConfig } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: '消息不能为空' });
    }
    
    // 1. 获取会话配置
    const { data: sessionConfig } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', id)
      .single();
    
    // 2. 保存用户消息
    await supabase
      .from('messages')
      .insert({
        session_id: id,
        role: 'user',
        content: message
      });
    
    // 3. 更新会话时间
    await supabase
      .from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', id);
    
    // 4. 获取设置
    const { data: settings } = await supabase
      .from('settings')
      .select('*')
      .eq('session_id', 'global')
      .single();
    
    // 5. 构建上下文
    let context = await buildContext(id, settings, sessionConfig);
    
    // 6. 添加当前用户消息
    context.push({
      role: 'user',
      content: message
    });
    
    // 7. 检查 token 数
    const tokenCount = countTokens(context);
    console.log(`当前 token 数: ${tokenCount}`);
    
    if (tokenCount > settings.compress_threshold) {
      console.log('触发记忆压缩...');
      await compressMemory(id, settings, apiConfig);
      context = await buildContext(id, settings, sessionConfig);
      context.push({
        role: 'user',
        content: message
      });
    }
    
    // 8. 调用 AI
    const reply = await callAI(context, apiConfig.model, apiConfig);
    
    // 9. 保存 AI 回复
    await supabase
      .from('messages')
      .insert({
        session_id: id,
        role: 'assistant',
        content: reply
      });
    
    // 10. 检查是否需要自动总结
    if (sessionConfig.memory_summary_enabled) {
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', id);
      
      const { count: summaryCount } = await supabase
        .from('memory_summaries')
        .select('*', { count: 'exact', head: true })
        .eq('session_id', id);
      
      const messagesPerSummary = sessionConfig.memory_summary_interval * 2;
      const expectedSummaries = Math.floor(count / messagesPerSummary);
      
      if (summaryCount < expectedSummaries) {
        // 需要生成新的总结
        const { data: recentMessages } = await supabase
          .from('messages')
          .select('*')
          .eq('session_id', id)
          .order('created_at', { ascending: false })
          .limit(messagesPerSummary);
        
        if (recentMessages && recentMessages.length > 0) {
          const contentToSummarize = recentMessages
            .reverse()
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');
          
          try {
            const summaryResponse = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiConfig.apiKey}`
              },
              body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                  {
                    role: 'system',
                    content: '请将以下对话内容总结成简短的记忆，保留关键信息、情感和重要细节。'
                  },
                  {
                    role: 'user',
                    content: contentToSummarize
                  }
                ]
              })
            });
            
            const summaryData = await summaryResponse.json();
            const summary = summaryData.choices[0].message.content;
            
            await supabase
              .from('memory_summaries')
              .insert({
                session_id: id,
                summary: summary
              });
            
            console.log('自动生成记忆总结成功');
          } catch (error) {
            console.error('自动总结失败:', error);
          }
        }
      }
    }
    
    res.json({ reply });
  } catch (error) {
    console.error('对话失败:', error);
    res.status(500).json({ error: '对话失败' });
  }
});

// ========== 世界书 API ==========

// 获取世界书列表
app.get('/api/sessions/:id/worldbook', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('world_book')
      .select('*')
      .eq('session_id', id)
      .order('created_at', { ascending: true });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('获取世界书失败:', error);
    res.status(500).json({ error: '获取世界书失败' });
  }
});

// 添加世界书条目
app.post('/api/sessions/:id/worldbook', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, content } = req.body;
    
    const { data, error } = await supabase
      .from('world_book')
      .insert({
        session_id: id,
        name,
        content
      })
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('添加世界书失败:', error);
    res.status(500).json({ error: '添加世界书失败' });
  }
});

// 更新世界书条目
app.patch('/api/worldbook/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, content } = req.body;
    
    const { data, error } = await supabase
      .from('world_book')
      .update({ name, content })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('更新世界书失败:', error);
    res.status(500).json({ error: '更新世界书失败' });
  }
});

// 删除世界书条目
app.delete('/api/worldbook/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('world_book')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('删除世界书失败:', error);
    res.status(500).json({ error: '删除世界书失败' });
  }
});

// ========== 记忆总结 API ==========

// 获取记忆总结列表
app.get('/api/sessions/:id/summaries', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('memory_summaries')
      .select('*')
      .eq('session_id', id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('获取记忆总结失败:', error);
    res.status(500).json({ error: '获取记忆总结失败' });
  }
});

// 更新记忆总结
app.patch('/api/summaries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { summary } = req.body;
    
    const { data, error } = await supabase
      .from('memory_summaries')
      .update({ summary })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('更新记忆总结失败:', error);
    res.status(500).json({ error: '更新记忆总结失败' });
  }
});

// 删除记忆总结
app.delete('/api/summaries/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('memory_summaries')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('删除记忆总结失败:', error);
    res.status(500).json({ error: '删除记忆总结失败' });
  }
});

// 删除所有记忆总结
app.delete('/api/sessions/:id/summaries', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('memory_summaries')
      .delete()
      .eq('session_id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('删除所有记忆总结失败:', error);
    res.status(500).json({ error: '删除所有记忆总结失败' });
  }
});

// ========== 系统设置 API ==========

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
