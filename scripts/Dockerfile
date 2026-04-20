# TB-3PO Module Build Environment
# Target: Ableton Move (aarch64 Linux)

FROM debian:bookworm

RUN apt-get update && apt-get install -y \
    gcc-aarch64-linux-gnu \
    make \
    file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

ENV CROSS_PREFIX=aarch64-linux-gnu-
ENV CC=aarch64-linux-gnu-gcc
