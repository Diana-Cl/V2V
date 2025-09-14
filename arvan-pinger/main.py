import asyncio
from fastapi import FastAPI, Body
from typing import List, Dict

app = FastAPI()

async def test_latency(host: str, port: int) -> Dict:
    """Tests TCP latency for a single host and port."""
    try:
        start_time = asyncio.get_event_loop().time()
        # Set a timeout for the connection attempt
        fut = asyncio.open_connection(host, port)
        await asyncio.wait_for(fut, timeout=3.0)

        latency = (asyncio.get_event_loop().time() - start_time) * 1000  # Convert to ms

        reader, writer = fut.result()
        writer.close()
        await writer.wait_closed()

        return {"host": host, "port": port, "ping": int(latency), "status": "success"}
    except Exception:
        return {"host": host, "port": port, "ping": None, "status": "failure"}

@app.post("/test-tcp")
async def run_tcp_tests(configs: List[Dict] = Body(...)):
    """Receives a list of configs and tests them concurrently."""
    tasks = [test_latency(config.get("host"), config.get("port")) for config in configs if config.get("host") and config.get("port")]
    results = await asyncio.gather(*tasks)
    return results

@app.get("/")
def root():
    return {"message": "V2V Pinger Service is ready!"}
