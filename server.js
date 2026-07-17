import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化 Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  // 测试数据库连接
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .limit(1);
  
  res.json({ 
    status: 'ok', 
    message: '服务正常运行',
    database: error ? 'disconnected' : 'connected',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({ message: 'Chat Backend API' });
});

app.post('/chat', async (req, res) => {
  try {
    const { message, apiConfig } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: '消息不能为空' });
    }

    if (!apiConfig || !apiConfig.baseUrl || !apiConfig.apiKey) {
      return res.status(400).json({ error: 'API 配置不完整' });
    }

    // 调用 AI API
    const aiResponse = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiConfig.apiKey}`
      },
      body: JSON.stringify({
        model: apiConfig.model || 'gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: message
          }
        ],
        stream: false
      })
    });

    if (!aiResponse.ok) {
      const error = await aiResponse.text();
      console.error('AI API 错误:', error);
      return res.status(500).json({ error: 'AI 服务调用失败' });
    }

    const aiData = await aiResponse.json();
    const reply = aiData.choices[0].message.content;
    
    res.json({ 
      reply,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('服务器错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
