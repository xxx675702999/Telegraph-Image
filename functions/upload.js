// functions/upload.js
import { errorHandling, telemetryData } from './utils/middleware';

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

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

        // 保存到 KV 存储（如果启用了图片管理功能）
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

        // 🎉 新增功能：发送文件访问链接通知
        await sendFileNotification(env, {
            fileName: fileName,
            fileSize: uploadFile.size,
            fileUrl: fullUrl,
            fileType: uploadFile.type,
            fileId: fileId
        });

        return new Response(
            JSON.stringify([{ 'src': fileUrl }]),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { 
            method: "POST", 
            body: formData 
        });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}

// 🎉 新增功能：发送文件访问链接通知
async function sendFileNotification(env, fileInfo) {
    const { fileName, fileSize, fileUrl, fileType, fileId } = fileInfo;
    
    // 如果设置了 DISABLE_NOTIFICATION 环境变量，则跳过通知
    if (env.DISABLE_NOTIFICATION === 'true') {
        return;
    }

    // 格式化文件大小
    const formatFileSize = (bytes) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    };

    // 获取文件类型图标
    const getFileIcon = (type) => {
        if (type.startsWith('image/')) return '🖼️';
        if (type.startsWith('video/')) return '🎬';
        if (type.startsWith('audio/')) return '🎵';
        if (type.includes('pdf')) return '📄';
        if (type.includes('zip') || type.includes('rar') || type.includes('7z')) return '📦';
        if (type.includes('text') || type.includes('json') || type.includes('xml')) return '📝';
        if (type.includes('word') || type.includes('doc')) return '📄';
        if (type.includes('excel') || type.includes('sheet')) return '📊';
        if (type.includes('powerpoint') || type.includes('presentation')) return '📊';
        return '📎';
    };

    // 构建通知消息
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

    // 发送通知的 API URL
    const notificationChatId = env.NOTIFICATION_CHAT_ID || env.TG_Chat_ID;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/sendMessage`;
    
    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                chat_id: notificationChatId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: false,
                // 添加内联键盘
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '🔗 直接访问',
                                url: fileUrl
                            },
                            {
                                text: '📋 复制链接',
                                callback_data: `copy_${fileId}`
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
        // 不抛出错误，避免影响主要的上传流程
    }
}

// 🎉 新增功能：处理回调查询（可选）
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    
    // 处理 Telegram webhook 回调
    if (url.pathname === '/webhook/telegram') {
        try {
            const update = await request.json();
            
            if (update.callback_query) {
                const callbackData = update.callback_query.data;
                const chatId = update.callback_query.message.chat.id;
                const messageId = update.callback_query.message.message_id;
                
                if (callbackData.startsWith('copy_')) {
                    const fileId = callbackData.replace('copy_', '');
                    
                    // 回应回调查询
                    await fetch(`https://api.telegram.org/bot${env.TG_Bot_Token}/answerCallbackQuery`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            callback_query_id: update.callback_query.id,
                            text: '链接已复制到剪贴板！',
                            show_alert: false
                        })
                    });
                }
            }
            
            return new Response('OK', { status: 200 });
        } catch (error) {
            console.error('Webhook error:', error);
            return new Response('Error', { status: 500 });
        }
    }
    
    // 默认返回 404
    return new Response('Not Found', { status: 404 });
}
