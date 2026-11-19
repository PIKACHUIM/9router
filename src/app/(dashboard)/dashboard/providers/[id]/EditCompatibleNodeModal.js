"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Badge, Input, Modal, Select, Textarea } from "@/shared/components";
import { CLIENT_PROFILE_UI_OPTIONS, DEFAULT_CLIENT_UA, normalizeClientProfile, resolveClientProfile, sanitizeClientUserAgent } from "open-sse/providers/clientProfiles.js";
import { CODEBUDDY_SYSTEM_PROMPT, DEFAULT_CLIENT_SYSTEM_PROMPT } from "open-sse/providers/defaultPrompts.js";

export default function EditCompatibleNodeModal({ isOpen, node, onSave, onClose, isAnthropic }) {
  const [formData, setFormData] = useState({
    name: "",
    prefix: "",
    apiType: "chat",
    baseUrl: "https://api.openai.com/v1",
    clientProfile: "auto",
    clientUserAgent: DEFAULT_CLIENT_UA,
  });
  const [saving, setSaving] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  // `null` = follow the channel family's prompt; a string is stored verbatim.
  const [systemPrompt, setSystemPrompt] = useState(null);

  useEffect(() => {
    if (node) {
      setFormData({
        name: node.name || "",
        prefix: node.prefix || "",
        apiType: node.apiType || "chat",
        baseUrl: node.baseUrl || (isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"),
        clientProfile: normalizeClientProfile(node.clientProfile),
        clientUserAgent: node.clientUserAgent || DEFAULT_CLIENT_UA,
      });
      setSystemPrompt(node.clientSystemPrompt || null);
    }
  }, [node, isAnthropic]);

  // CodeBuddy and WorkBuddy each expect their own prompt; a plain relay none.
  const profile = resolveClientProfile({
    provider: node?.id,
    credentials: {
      providerSpecificData: {
        clientProfile: formData.clientProfile,
        nodeName: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
      },
    },
  });
  const defaultSystemPrompt =
    profile?.id === "codebuddy"
      ? CODEBUDDY_SYSTEM_PROMPT
      : profile?.id === "workbuddy"
        ? DEFAULT_CLIENT_SYSTEM_PROMPT
        : "";
  const promptValue = systemPrompt ?? defaultSystemPrompt;

  const apiTypeOptions = [
    { value: "chat", label: "Chat Completions" },
    { value: "responses", label: "Responses API" },
  ];

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
        clientProfile: normalizeClientProfile(formData.clientProfile),
        clientUserAgent: sanitizeClientUserAgent(formData.clientUserAgent),
        // Unchanged text stays "" so the node keeps following the bundled default.
        clientSystemPrompt: promptValue.trim() === defaultSystemPrompt.trim() ? "" : promptValue,
      };
      if (!isAnthropic) {
        payload.apiType = formData.apiType;
      }
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: formData.baseUrl,
          apiKey: checkKey,
          type: isAnthropic ? "anthropic-compatible" : "openai-compatible",
          modelId: checkModelId.trim() || undefined
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  if (!node) return null;

  return (
    <Modal isOpen={isOpen} title={`Edit ${isAnthropic ? "Anthropic" : "OpenAI"} Compatible`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={`${isAnthropic ? "Anthropic" : "OpenAI"} Compatible (Prod)`}
          hint="Required. A friendly label for this node."
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={isAnthropic ? "ac-prod" : "oc-prod"}
          hint="Required. Used as the provider prefix for model IDs."
        />
        {!isAnthropic && (
          <Select
            label="API Type"
            options={apiTypeOptions}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
          hint={`Use the base URL (ending in /v1) for your ${isAnthropic ? "Anthropic" : "OpenAI"}-compatible API.`}
        />
        <Select
          label="Client Conversion"
          options={CLIENT_PROFILE_UI_OPTIONS}
          value={formData.clientProfile}
          onChange={(e) => setFormData({ ...formData, clientProfile: e.target.value })}
          hint="Sends the official client's User-Agent and marker headers upstream. Gateways that only accept CodeBuddy / WorkBuddy clients need this."
        />
        <Input
          label="Client User-Agent"
          value={formData.clientUserAgent}
          onChange={(e) => setFormData({ ...formData, clientUserAgent: e.target.value })}
          placeholder={DEFAULT_CLIENT_UA}
          hint="Sent upstream verbatim. Leave empty to use the default WorkBuddy UA."
          disabled={formData.clientProfile === "none"}
        />
        <Textarea
          label="System Prompt Override"
          value={promptValue}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={6}
          placeholder="Leave empty to use the channel's built-in prompt."
          disabled={formData.clientProfile === "none"}
          hint={
            formData.clientProfile === "none"
              ? "Client conversion is off, so no prompt is overridden."
              : defaultSystemPrompt
                ? `Replaces the conversation's system prompt upstream with the ${profile.label} prompt — ${promptValue.length.toLocaleString()} characters.`
                : "This channel is not detected as CodeBuddy / WorkBuddy, so the client's system prompt is forwarded unchanged."
          }
        />
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => setSystemPrompt(null)}
            disabled={systemPrompt === null}
          >
            Reset to default
          </Button>
          <Button variant="ghost" onClick={() => setSystemPrompt("")} disabled={!promptValue}>
            Clear
          </Button>
        </div>
        <div className="flex gap-2">
          <Input
            label="API Key (for Check)"
            type="password"
            value={checkKey}
            onChange={(e) => setCheckKey(e.target.value)}
            className="flex-1"
          />
          <div className="pt-6">
            <Button onClick={handleValidate} disabled={!checkKey || validating || !formData.baseUrl.trim()} variant="secondary">
              {validating ? "Checking..." : "Check"}
            </Button>
          </div>
        </div>
        <Input
          label="Model ID (optional)"
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder="e.g. my-model-id"
          hint="If provider lacks /models endpoint, enter a model ID to validate via chat/completions instead."
        />
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? "Valid" : "Invalid"}
          </Badge>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

EditCompatibleNodeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    prefix: PropTypes.string,
    apiType: PropTypes.string,
    baseUrl: PropTypes.string,
    clientProfile: PropTypes.string,
    clientUserAgent: PropTypes.string,
    clientSystemPrompt: PropTypes.string,
  }),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  isAnthropic: PropTypes.bool,
};
