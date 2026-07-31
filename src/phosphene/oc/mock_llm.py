"""Mock LLM provider for integration tests.

Returns canned responses so tests don't need real API keys or network access.
Implements a minimal OpenAI-compatible chat completions endpoint.
"""

from __future__ import annotations

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from typing import Any


class MockLLMHandler(BaseHTTPRequestHandler):
    """Handles /v1/chat/completions with canned streaming responses."""

    # Class-level — set before starting the server
    response_text: str = "OK"
    stream: bool = True
    delay_ms: int = 0

    def do_POST(self) -> None:
        """Handle chat completion requests."""
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.end_headers()
            return

        if MockLLMHandler.delay_ms > 0:
            time.sleep(MockLLMHandler.delay_ms / 1000)

        body = self._read_body()
        stream = body.get("stream", False)

        if stream:
            self._send_stream(MockLLMHandler.response_text)
        else:
            self._send_json(MockLLMHandler.response_text)

    def do_GET(self) -> None:
        """Handle health checks."""
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(404)
            self.end_headers()

    def _read_body(self) -> dict[str, Any]:
        """Read and parse the request body as JSON."""
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _send_json(self, text: str) -> None:
        """Send a non-streaming response."""
        response = {
            "id": "test-chatcmpl",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "test/model",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
        }
        data = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_stream(self, text: str) -> None:
        """Send a streaming SSE response."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        # Split text into chunks for realistic streaming
        words = text.split()
        for i, word in enumerate(words):
            chunk = {
                "id": "test-chatcmpl",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "test/model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "content": word + (" " if i < len(words) - 1 else ""),
                        },
                        "finish_reason": None,
                    }
                ],
            }
            line = f"data: {json.dumps(chunk)}\n\n"
            self.wfile.write(line.encode())
            self.wfile.flush()
            time.sleep(0.01)

        # Final chunk
        final = {
            "id": "test-chatcmpl",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "test/model",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        self.wfile.write(f"data: {json.dumps(final)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, format: str, *args: object) -> None:
        """Suppress request logging."""
        pass


class MockLLMServer:
    """Context manager for the mock LLM server.

    Usage:
        with MockLLMServer(port=9999) as server:
            server.set_response("Hello world")
            # ... make requests to http://127.0.0.1:9999/v1/chat/completions
    """

    def __init__(self, port: int = 9999) -> None:
        """Initialize with a port.

        Args:
            port: Port to listen on.
        """
        self.port = port
        self._server: HTTPServer | None = None
        self._thread: Thread | None = None

    def set_response(
        self,
        text: str,
        *,
        stream: bool = True,
        delay_ms: int = 0,
    ) -> None:
        """Set the canned response for the next request.

        Args:
            text: The response text to return.
            stream: Whether to stream the response.
            delay_ms: Delay before responding (simulates slow provider).
        """
        MockLLMHandler.response_text = text
        MockLLMHandler.stream = stream
        MockLLMHandler.delay_ms = delay_ms

    def start(self) -> None:
        """Start the mock server."""
        self._server = HTTPServer(("127.0.0.1", self.port), MockLLMHandler)
        self._thread = Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the mock server."""
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> MockLLMServer:
        """Start the server."""
        self.start()
        return self

    def __exit__(self, *args: object) -> None:
        """Stop the server."""
        self.stop()
