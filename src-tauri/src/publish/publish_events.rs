use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::publish::{PublishOutput, PublishSiteComplete, SitePublishResult};

pub(crate) fn emit_publish_event<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    let _ = app.emit(event, payload);
}

pub(crate) fn emit_publish_output(
    app: &AppHandle,
    publish_id: &str,
    site_code: &str,
    site_label: &str,
    line: impl Into<String>,
    is_stderr: bool,
) {
    emit_publish_event(
        app,
        "publish-output",
        PublishOutput {
            publish_id: publish_id.to_string(),
            site_code: site_code.to_string(),
            site_label: site_label.to_string(),
            line: line.into(),
            is_stderr,
        },
    );
}

pub(crate) fn emit_publish_site_complete(
    app: &AppHandle,
    publish_id: &str,
    result: &SitePublishResult,
) {
    emit_publish_event(
        app,
        "publish-site-complete",
        PublishSiteComplete {
            publish_id: publish_id.to_string(),
            site_code: result.site_code.clone(),
            site_label: result.site_label.clone(),
            success: result.success,
            message: result.message.clone(),
        },
    );
}