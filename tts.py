import asyncio
import sys

asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from edge_tts import Communicate

async def main():
    text_file = sys.argv[1]
    voice = sys.argv[2]
    output_file = sys.argv[3]

    with open(text_file, 'r', encoding='utf-8') as f:
        text = f.read()

    communicate = Communicate(text, voice)
    await communicate.save(output_file)

asyncio.run(main())
