from harness.llm.base import LLMClient, ChatResponse
from harness.llm.ollama_client import OllamaClient
from harness.llm.mock_client import MockClient


def make_client(provider: str = "ollama", mock: bool = False) -> LLMClient:
    if mock or provider == "mock":
        return MockClient()
    if provider == "ollama":
        return OllamaClient()
    # Later: if provider == "anthropic": return AnthropicClient()
    raise ValueError(f"Unknown provider: {provider}")