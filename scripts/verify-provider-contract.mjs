#!/usr/bin/env node
/**
 * Offline provider/mock contract gate (no network, no credentials, no paid APIs).
 *
 * Validates that the Rust contract module and fixture inventory cover the V2
 * strict Models / Responses / Chat / Anthropic Messages / refusal / malformed /
 * usage / timeout / redirect / Vision scenarios. This is a static inventory +
 * shape check; behavioral assertions live in `cargo test` under
 * `ai::provider_contract`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const contractPath = path.join(
  rootDir,
  'src-tauri',
  'src',
  'ai',
  'provider_contract.rs',
);
const redactionPath = path.join(rootDir, 'src-tauri', 'src', 'ai', 'redaction.rs');
const providerPath = path.join(rootDir, 'src-tauri', 'src', 'ai', 'provider.rs');

const REQUIRED_SCENARIOS = [
  'ModelsListOpenAi',
  'ModelsListAnthropic',
  'ResponsesStrictOk',
  'ChatStrictOk',
  'AnthropicMessagesStrictOk',
  'ChatRefusal',
  'ResponsesRefusal',
  'AnthropicRefusal',
  'MalformedJson',
  'SchemaIncompatible',
  'UsageNormalized',
  'TimeoutHttp',
  'AuthFailure',
  'Redirect',
  'VisionResponses',
  'VisionChat',
  'VisionAnthropic',
];

const REQUIRED_MARKERS = [
  'spawn_oneshot_mock',
  'localhost_mock_models_list_never_leaves_loopback',
  'localhost_mock_responses_strict_extracts_findings',
  'localhost_mock_auth_failure_never_echoes_canary',
  'localhost_mock_redirect_is_classified_without_following',
  'ordinary_audit_text_with_word_refusal_is_not_envelope_refusal',
  'CANARY_SECRET',
  'assert_request_body_sanitary',
  // Must never instruct live network.
  'never call live or paid providers',
];

const FORBIDDEN_MARKERS = [
  'api.openai.com/v1/chat',
  'api.anthropic.com/v1/messages',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'sk-live-',
  'sk-proj-',
];

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    die(`${label}: missing required marker ${JSON.stringify(needle)}`);
  }
}

function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    die(`${label}: forbidden marker present ${JSON.stringify(needle)}`);
  }
}

function main() {
  for (const filePath of [contractPath, redactionPath, providerPath]) {
    if (!existsSync(filePath)) {
      die(`required source missing: ${path.relative(rootDir, filePath)}`);
    }
  }

  const contract = readFileSync(contractPath, 'utf8');
  const redaction = readFileSync(redactionPath, 'utf8');
  const provider = readFileSync(providerPath, 'utf8');

  for (const scenario of REQUIRED_SCENARIOS) {
    assertContains(contract, scenario, 'provider_contract scenarios');
  }
  for (const marker of REQUIRED_MARKERS) {
    assertContains(contract, marker, 'provider_contract markers');
  }
  for (const marker of FORBIDDEN_MARKERS) {
    assertNotContains(contract, marker, 'provider_contract');
  }

  // Security/redaction corpus must remain present and canary-aware.
  assertContains(redaction, 'sk-proj-', 'redaction corpus');
  assertContains(redaction, 'REDACTED', 'redaction corpus');
  assertContains(redaction, 'redacts_production_api_key_shapes', 'redaction tests');
  assertContains(redaction, 'redacts_paths_urls_and_image_payloads', 'redaction tests');

  // Production provider module must keep no-redirect + envelope-only refusal rules.
  assertContains(provider, 'redirect::Policy::none()', 'provider no-redirect');
  assertContains(provider, 'has_refusal', 'provider refusal helper');
  assertContains(provider, 'openai_chat_has_refusal', 'provider chat refusal');
  assertContains(provider, 'anthropic_messages_has_refusal', 'provider anthropic refusal');
  assertContains(
    provider,
    'ordinary_audit_text_containing_word_refusal_is_not_provider_refusal',
    'provider refusal regression',
  );

  console.log('verify-provider-contract: ok');
  console.log(`  scenarios: ${REQUIRED_SCENARIOS.length}`);
  console.log('  network: offline-only (static inventory + cargo contract tests)');
  console.log('  credentials: none');
}

main();
