FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    IFC_ATLAS_HOME=/home/ifcatlas/.ifc-atlas

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin ifcatlas \
    && install -d -o ifcatlas -g ifcatlas /home/ifcatlas/.ifc-atlas

COPY --chown=ifcatlas:ifcatlas . .

USER ifcatlas

EXPOSE 8000

CMD ["python", "run.py"]
