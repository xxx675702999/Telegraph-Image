// functions/upload.js

// 假设您的工具函数文件路径正确
import { errorHandling, telemetryData } from './utils/middleware';

/**
 * 主请求处理器 (POST)
 * 该函数现在作为一个路由器，根据请求类型分发到不同的处理器。
 * - 'multipart/form-data': 处理文件上传。
 * - 'application/json': 处理 Telegram Webhook 回调。
 */
export async function onRequestPost(context) {
    const { request } = context;
    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
        return handleFileUpload(context);
    } else if (contentType.includes('application/json')) {
        return handleTelegramWebhook(context);
    }

    return new Response('Unsupported request type. Please send either multipart/form-data for uploads or application/json for webhooks.', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
    });
}

/**
 * 处理文件上传
 */
async function handleFileUpload(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        // 运行中间件
        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        // 创建 Telegram 上传表单
        const telegramFormData = new FormData();
        telegramFormData.append("chat_id", env.TG_Chat_ID);

        // 根据文件类型选择合适的上传方式
        let apiEndpoint;
        if (uploadFile.type.startsWith('image/')) {
            telegramFormData.append("photo", uploadFile);
            apiEndpoint = 'sendPhoto';
        } else if (uploadFile.type.startsWith('audio/')) {
            telegramFormData.append("audio", uploadFile);
            apiEndpoint = 'sendAudio';
        } else if (uploadFile.type.startsWith('video/')) {
            telegramFormData.append("video", uploadFile);
            apiEndpoint = 'sendVideo';
        } else {
            telegramFormData.append("document", uploadFile);
            apiEndpoint = 'sendDocument';
        }

        // 上传到 Telegram
        const result = await sendToTelegram(telegramFormData, apiEndpoint, env);
        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);
        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        // 构建文件访问链接
        const fileUrl = `/file/${fileId}.${fileExtension}`;
        const fullUrl = `${new URL(request.url).origin}${fileUrl}`;

        // 保存到 KV 存储
        if (env.img_url) {
            await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                metadata: {
                    TimeStamp: Date.now(),
                    ListType: "None",
                    Label: "None",
                    liked: false,
                    fileName: fileName,
                    fileSize: uploadFile.size,
                    fileType: uploadFile.type,
                    uploadedAt: new Date().toISOString()
                }
            });
        }

        // 发送文件访问链接通知
        await sendFileNotification(env, {
            fileName,
            fileSize: uploadFile.size,
            fileUrl: fullUrl,
            fileType: uploadFile.type,
            fileId: fileId
        });

        return new Response(
            JSON.stringify([{ 'src': fileUrl }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

/**
 * 处理 Telegram Webhook 回调
 */
async function handleTelegramWebhook(context) {
    const { request, env } = context;
    try {
        const update = await request.json();
        
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const callbackData = callbackQuery.data;
            
            // ✅ 核心修复：检查固定的、简短的回调数据
            if (callbackData === 'copy_link') {
                const messageText = callbackQuery.message.text;
                let alertText = '无法找到链接。';

                // ✅ 从消息文本中用正则表达式提取链接
                // 这个表达式匹配被 ``` 包围的 URL
                const urlRegex = /```\n(https?:\/\/[^\s]+)\n```/;
                const match = messageText.match(urlRegex);

                if (match && match[1]) {
                    const urlToCopy = match[1];
                    alertText = `链接已准备好，请粘贴！\n\n${urlToCopy}`;
                }
                
                // 回应回调查询，弹窗提示用户
                await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callback_query_id: callbackQuery.id,
                        text: alertText,
                        show_alert: true // 使用弹窗提示，效果更好
                    })
                });
            }
        }
        
        return new Response('OK', { status: 200 });
    } catch (error) {
        console.error('Webhook error:', error);
        return new Response('Error handling webhook', { status: 500 });
    }
}


/**
 * 发送文件访问链接通知到 Telegram
 */
async function sendFileNotification(env, fileInfo) {
    const { fileName, fileSize, fileUrl, fileType, fileId } = fileInfo;
    
    if (env.DISABLE_NOTIFICATION === 'true') return;

    const formatFileSize = (bytes) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    };

    const getFileIcon = (type) => {
        if (type.startsWith('image/')) return '🖼️';
        if (type.startsWith('video/')) return '🎬';
        if (type.startsWith('audio/')) return '🎵';
        if (type.includes('pdf')) return '📄';
        if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return '📦';
        return '📎';
    };

    // 构建通知消息，注意 URL 被包裹在 ``` 中，便于提取
    const message = `
🎉 **文件上传成功！**

${getFileIcon(fileType)} **文件名：** \`${fileName}\`
📏 **大小：** ${formatFileSize(fileSize)}
🆔 **文件ID：** \`${fileId}\`
🔗 **访问链接：** [点击访问](${fileUrl})

\`\`\`
${fileUrl}
\`\`\`

_通过 Telegraph-Image 上传_
    `.trim();

    const notificationChatId = env.NOTIFICATION_CHAT_ID || env.TG_Chat_ID;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendMessage`;
    
    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: notificationChatId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: false,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 直接访问', url: fileUrl },
                            {
                                text: '📋 复制链接',
                                // ✅ 核心修复：使用一个简短、固定的字符串，而不是长 file_id
                                // 这个值不能超过 64 字节
                                callback_data: `copy_link`
                            }
                        ]
                    ]
                }
            })
        });

        const result = await response.json();
        if (!response.ok) {
            console.error('Failed to send notification:', result);
        } else {
            console.log('File notification sent successfully');
        }
    } catch (error) {
        console.error('Error sending file notification:', error);
    }
}

// --- 以下是未作修改的辅助函数 ---

function getFileId(response) {
    if (!response.ok || !response.result) return null;
    const result = response.result;
    if (result.photo) return result.photo.reduce((prev, current) => (prev.file_size > current.file_size) ? prev : current).file_id;
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;
    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return { success: false, error: responseData.description || 'Upload to Telegram failed' };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}
