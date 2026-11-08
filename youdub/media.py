"""Shared media container conversion, without model dependencies."""
import subprocess


def remux_to_mp4(source, destination):
    try:
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', source,
                        '-c', 'copy', destination, '-y'], check=True)
    except subprocess.CalledProcessError:
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', source,
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
                        destination, '-y'], check=True)
