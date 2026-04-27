use crate::publish::{PublishComplete, PublishRequest};
use crate::publish::publish_events::emit_publish_event;
use crate::services::publish_service::run_publish;

pub async fn publish(app: tauri::AppHandle, request: PublishRequest) -> Result<(), String> {
    let app_handle = app.clone();
    let request_payload = request.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_publish(&app_handle, &request_payload))
        .await
        .map_err(|error| format!("发布任务执行失败: {}", error))?;

    let completion = match &result {
        Ok(message) => PublishComplete {
            publish_id: request.publish_id.clone(),
            success: true,
            message: message.clone(),
        },
        Err(message) => PublishComplete {
            publish_id: request.publish_id.clone(),
            success: false,
            message: message.clone(),
        },
    };

    emit_publish_event(&app, "publish-complete", completion);
    result.map(|_| ())
}