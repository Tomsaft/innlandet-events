import time
import requests
from harness.llm.base import LLMClient, ChatResponse


class OllamaClient(LLMClient):
    def __init__(self, host="http://localhost:11434"):
        self.host = host

    def chat(self, model, messages, temperature=0.2):
        t0 = time.monotonic()
        try:
            resp = requests.post(
                f"{self.host}/api/chat",
                json={"model": model, "messages": messages, "stream": False,
                      "options": {"temperature": temperature}},
                timeout=300,
            )
        except requests.ConnectionError:
            raise RuntimeError("Cannot connect to Ollama. Is it running?") from None
        if resp.status_code == 404:
            raise RuntimeError(f"Model '{model}' not found. Run: ollama pull {model}")
        resp.raise_for_status()
        data = resp.json()
        return ChatResponse(
            text=data["message"]["content"].strip(),
            prompt_tokens=data.get("prompt_eval_count", 0),
            completion_tokens=data.get("eval_count", 0),
            seconds=time.monotonic() - t0,
        )