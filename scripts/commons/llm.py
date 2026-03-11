"""Unified LLM client layer — single provider.

Supported provider types:
  - bedrock    — AWS Bedrock (uses boto3 + AWS credentials, model = inference profile ARN)
  - openai     — OpenAI API (also vLLM, LocalAI, any OpenAI-compatible)
  - claude     — Anthropic Claude direct API
  - ollama     — Local Ollama
  - litellm    — LiteLLM proxy
  - openrouter — OpenRouter

Config format (flat, single provider):
    llm:
      type: bedrock         # bedrock | ollama | openai | claude | litellm | openrouter
      model: arn:aws:bedrock:us-west-2:123456789:inference-profile/us.anthropic.claude-...
      temperature: 0.7
      streaming: true

Usage:
    from scripts.commons.llm import init_llm, get_llm_client

    # At startup (called by server.py):
    init_llm(config["llm"])

    # In app code:
    client = get_llm_client()

    # Non-streaming chat:
    result = await client.chat(messages=[{"role": "user", "content": "Hello"}])
    # => {"content": "...", "model": "...", "usage": {...}}

    # Streaming chat:
    async for chunk in client.chat_stream(messages=[...]):
        print(chunk)  # {"content": "partial text", "done": False}

    # Convenience:
    text = await client.generate("Summarize this: ...")
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator

import httpx

log = logging.getLogger("marchdeck.llm")

# ── Module-level state ────────────────────────────────────────────────

_client: LLMClient | None = None


def init_llm(llm_config: dict) -> None:
    """Initialize the LLM client from config. Called once at server startup."""
    global _client
    _client = None

    if not llm_config:
        log.info("No LLM config — LLM features disabled")
        return

    ptype = llm_config.get("type", "")
    model = llm_config.get("model", "")
    if not ptype or not model:
        log.info("LLM config missing 'type' or 'model' — LLM features disabled")
        return

    try:
        _client = LLMClient(config=llm_config)
        log.info(f"LLM ready (type={ptype}, model={model})")
    except Exception as e:
        log.warning(f"LLM init failed: {e}")


def get_llm_client(name: str | None = None) -> LLMClient:
    """Get the configured LLM client. The name parameter is ignored (kept for backward compat)."""
    if _client is None:
        raise RuntimeError("No LLM configured. Add llm section to config.yaml.")
    return _client


# ── LLMClient ─────────────────────────────────────────────────────────

class LLMClient:
    """Unified LLM client that adapts to different provider APIs."""

    def __init__(self, config: dict) -> None:
        self.provider_type: str = config["type"]
        self.model: str = config["model"]
        self.temperature: float = config.get("temperature", 0.7)
        self.streaming: bool = config.get("streaming", True)
        self.context_window: int | None = config.get("context_window")
        self.max_tokens: int = config.get("max_tokens", 4096)

        # Provider-specific
        self.api_key: str = config.get("api_key", "")
        self.endpoint: str = ""

        if self.provider_type == "bedrock":
            self.endpoint = ""  # uses boto3, no HTTP endpoint
            self._bedrock_client = None  # lazy init
        elif self.provider_type == "openai":
            self.endpoint = config.get("endpoint", "https://api.openai.com/v1").rstrip("/")
        elif self.provider_type == "claude":
            self.endpoint = "https://api.anthropic.com"
        elif self.provider_type == "ollama":
            self.endpoint = config.get("endpoint", "http://localhost:11434").rstrip("/")
        elif self.provider_type == "litellm":
            ep = config.get("endpoint", "")
            if not ep:
                raise ValueError("LiteLLM provider requires 'endpoint'")
            self.endpoint = ep.rstrip("/")
        elif self.provider_type == "openrouter":
            self.endpoint = "https://openrouter.ai/api/v1"
        else:
            raise ValueError(f"Unknown LLM provider type: {self.provider_type}")

        # Shared httpx client
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0))

    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """Non-streaming chat completion. Returns {"content", "model", "usage"}."""
        temp = temperature if temperature is not None else self.temperature
        mtok = max_tokens if max_tokens is not None else self.max_tokens

        if self.provider_type in ("openai", "litellm", "openrouter"):
            return await self._chat_openai(messages, temp, mtok)
        elif self.provider_type == "bedrock":
            return await self._chat_bedrock(messages, temp, mtok)
        elif self.provider_type == "claude":
            return await self._chat_claude(messages, temp, mtok)
        elif self.provider_type == "ollama":
            return await self._chat_ollama(messages, temp, mtok)
        else:
            raise RuntimeError(f"Unsupported provider type: {self.provider_type}")

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming chat completion. Yields {"content", "done"} chunks."""
        temp = temperature if temperature is not None else self.temperature
        mtok = max_tokens if max_tokens is not None else self.max_tokens

        if self.provider_type in ("openai", "litellm", "openrouter"):
            async for chunk in self._stream_openai(messages, temp, mtok):
                yield chunk
        elif self.provider_type == "bedrock":
            async for chunk in self._stream_bedrock(messages, temp, mtok):
                yield chunk
        elif self.provider_type == "claude":
            async for chunk in self._stream_claude(messages, temp, mtok):
                yield chunk
        elif self.provider_type == "ollama":
            async for chunk in self._stream_ollama(messages, temp, mtok):
                yield chunk
        else:
            raise RuntimeError(f"Unsupported provider type: {self.provider_type}")

    async def generate(
        self,
        prompt: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """Convenience: single prompt → text response."""
        result = await self.chat(
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return result["content"]

    # ── AWS Bedrock (boto3 Converse API) ─────────────────────────────

    def _get_bedrock_client(self):
        """Lazy-init boto3 bedrock-runtime client."""
        if self._bedrock_client is None:
            import boto3
            self._bedrock_client = boto3.client("bedrock-runtime")
        return self._bedrock_client

    def _to_bedrock_messages(self, messages: list[dict]) -> tuple[str | None, list[dict]]:
        """Convert OpenAI-style messages to Bedrock Converse format."""
        system = None
        converse_msgs = []
        for m in messages:
            role = m.get("role", "user")
            content = m.get("content", "")
            if role == "system":
                system = content
            else:
                br_role = "assistant" if role == "assistant" else "user"
                converse_msgs.append({
                    "role": br_role,
                    "content": [{"text": content}],
                })
        return system, converse_msgs

    async def _chat_bedrock(
        self, messages: list[dict], temp: float, mtok: int
    ) -> dict[str, Any]:
        import asyncio
        client = self._get_bedrock_client()
        system, msgs = self._to_bedrock_messages(messages)

        kwargs: dict[str, Any] = {
            "modelId": self.model,
            "messages": msgs,
            "inferenceConfig": {
                "temperature": temp,
                "maxTokens": mtok,
            },
        }
        if system:
            kwargs["system"] = [{"text": system}]

        def _call():
            return client.converse(**kwargs)

        resp = await asyncio.to_thread(_call)
        output = resp.get("output", {}).get("message", {})
        text = "".join(
            b.get("text", "") for b in output.get("content", []) if "text" in b
        )
        usage = resp.get("usage", {})
        return {
            "content": text,
            "model": self.model,
            "usage": {
                "prompt_tokens": usage.get("inputTokens", 0),
                "completion_tokens": usage.get("outputTokens", 0),
            },
        }

    async def _stream_bedrock(
        self, messages: list[dict], temp: float, mtok: int
    ) -> AsyncIterator[dict[str, Any]]:
        import asyncio
        client = self._get_bedrock_client()
        system, msgs = self._to_bedrock_messages(messages)

        kwargs: dict[str, Any] = {
            "modelId": self.model,
            "messages": msgs,
            "inferenceConfig": {
                "temperature": temp,
                "maxTokens": mtok,
            },
        }
        if system:
            kwargs["system"] = [{"text": system}]

        def _call():
            return client.converse_stream(**kwargs)

        resp = await asyncio.to_thread(_call)
        stream = resp.get("stream", [])

        # Stream events come synchronously from boto3
        def _iter_events():
            events = []
            for event in stream:
                events.append(event)
            return events

        all_events = await asyncio.to_thread(_iter_events)
        for event in all_events:
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                text = delta.get("text", "")
                if text:
                    yield {"content": text, "done": False}
            elif "messageStop" in event:
                yield {"content": "", "done": True}
                return
        yield {"content": "", "done": True}

    # ── OpenAI-compatible (openai / litellm / openrouter) ─────────────

    def _openai_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.provider_type == "openrouter":
            headers["HTTP-Referer"] = "https://march-deck.local"
            headers["X-Title"] = "March Deck"
        return headers

    async def _chat_openai(
        self, messages: list[dict], temp: float, mtok: int
    ) -> dict[str, Any]:
        url = f"{self.endpoint}/chat/completions"
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temp,
            "max_tokens": mtok,
            "stream": False,
        }
        resp = await self._http.post(url, json=payload, headers=self._openai_headers())
        if resp.status_code != 200:
            raise RuntimeError(f"LLM request failed ({resp.status_code}): {resp.text[:500]}")
        data = resp.json()
        choice = data["choices"][0]
        return {
            "content": choice["message"]["content"],
            "model": data.get("model", self.model),
            "usage": data.get("usage", {}),
        }

    async def _stream_openai(
        self, messages: list[dict], temp: float, mtok: int
    ) -> AsyncIterator[dict[str, Any]]:
        url = f"{self.endpoint}/chat/completions"
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": temp,
            "max_tokens": mtok,
            "stream": True,
        }
        async with self._http.stream(
            "POST", url, json=payload, headers=self._openai_headers()
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise RuntimeError(f"LLM stream failed ({resp.status_code}): {body.decode()[:500]}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    yield {"content": "", "done": True}
                    return
                try:
                    data = json.loads(data_str)
                    delta = data["choices"][0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield {"content": content, "done": False}
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
        yield {"content": "", "done": True}

    # ── Anthropic Claude ──────────────────────────────────────────────

    def _claude_headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }

    def _claude_split_system(
        self, messages: list[dict]
    ) -> tuple[str | None, list[dict]]:
        """Extract system message (Claude uses a top-level system param)."""
        system = None
        filtered = []
        for m in messages:
            if m.get("role") == "system":
                system = m["content"]
            else:
                filtered.append(m)
        return system, filtered

    async def _chat_claude(
        self, messages: list[dict], temp: float, mtok: int
    ) -> dict[str, Any]:
        url = f"{self.endpoint}/v1/messages"
        system, msgs = self._claude_split_system(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": msgs,
            "temperature": temp,
            "max_tokens": mtok,
            "stream": False,
        }
        if system:
            payload["system"] = system
        resp = await self._http.post(url, json=payload, headers=self._claude_headers())
        if resp.status_code != 200:
            raise RuntimeError(f"Claude request failed ({resp.status_code}): {resp.text[:500]}")
        data = resp.json()
        content_parts = data.get("content", [])
        text = "".join(p.get("text", "") for p in content_parts if p.get("type") == "text")
        return {
            "content": text,
            "model": data.get("model", self.model),
            "usage": data.get("usage", {}),
        }

    async def _stream_claude(
        self, messages: list[dict], temp: float, mtok: int
    ) -> AsyncIterator[dict[str, Any]]:
        url = f"{self.endpoint}/v1/messages"
        system, msgs = self._claude_split_system(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": msgs,
            "temperature": temp,
            "max_tokens": mtok,
            "stream": True,
        }
        if system:
            payload["system"] = system
        async with self._http.stream(
            "POST", url, json=payload, headers=self._claude_headers()
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise RuntimeError(f"Claude stream failed ({resp.status_code}): {body.decode()[:500]}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:]
                try:
                    data = json.loads(data_str)
                    event_type = data.get("type", "")
                    if event_type == "content_block_delta":
                        delta = data.get("delta", {})
                        text = delta.get("text", "")
                        if text:
                            yield {"content": text, "done": False}
                    elif event_type == "message_stop":
                        yield {"content": "", "done": True}
                        return
                except (json.JSONDecodeError, KeyError):
                    continue
        yield {"content": "", "done": True}

    # ── Ollama ────────────────────────────────────────────────────────

    async def _chat_ollama(
        self, messages: list[dict], temp: float, mtok: int
    ) -> dict[str, Any]:
        url = f"{self.endpoint}/api/chat"
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": temp,
                "num_predict": mtok,
            },
        }
        resp = await self._http.post(url, json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"Ollama request failed ({resp.status_code}): {resp.text[:500]}")
        data = resp.json()
        msg = data.get("message", {})
        return {
            "content": msg.get("content", ""),
            "model": data.get("model", self.model),
            "usage": {
                "prompt_tokens": data.get("prompt_eval_count", 0),
                "completion_tokens": data.get("eval_count", 0),
            },
        }

    async def _stream_ollama(
        self, messages: list[dict], temp: float, mtok: int
    ) -> AsyncIterator[dict[str, Any]]:
        url = f"{self.endpoint}/api/chat"
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "options": {
                "temperature": temp,
                "num_predict": mtok,
            },
        }
        async with self._http.stream("POST", url, json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise RuntimeError(f"Ollama stream failed ({resp.status_code}): {body.decode()[:500]}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    msg = data.get("message", {})
                    content = msg.get("content", "")
                    done = data.get("done", False)
                    if content:
                        yield {"content": content, "done": False}
                    if done:
                        yield {"content": "", "done": True}
                        return
                except (json.JSONDecodeError, KeyError):
                    continue
        yield {"content": "", "done": True}
