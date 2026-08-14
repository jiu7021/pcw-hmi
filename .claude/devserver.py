#!/usr/bin/env python3
"""개발용 정적 서버 — 캐시를 끈다.

기본 http.server는 Last-Modified만 주므로 브라우저가 휴리스틱 캐시로 옛 JS를
계속 쓰는 일이 생긴다(파일을 고쳐도 화면이 안 바뀜). 확인 작업 중에는 항상
최신 파일이 나가야 하므로 no-store를 붙인다. 배포와는 무관한 개발 전용이다.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
