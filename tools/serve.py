#!/usr/bin/env python3
"""Tiny static server for Graphnote (no dependencies). Serves ./app, opens the browser, prints the iPad URL."""
import http.server, mimetypes, os, socket, sys, threading, webbrowser

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    if not os.path.isfile(os.path.join(ROOT, "index.html")):
        sys.exit("Папку app не знайдено поруч зі скриптом. Розпакуйте архів повністю.")
    server = None
    for port in range(8080, 8100):
        try:
            server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        sys.exit("Не вдалося зайняти порт 8080-8099.")
    ip = lan_ip()
    print("\n  Graphnote запущено\n")
    print(f"  На цьому комп'ютері:  http://localhost:{port}")
    if ip:
        print(f"  На iPad (та сама Wi-Fi): http://{ip}:{port}")
    print("\n  Щоб зупинити — закрийте це вікно (Ctrl+C).\n")
    threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


main()
