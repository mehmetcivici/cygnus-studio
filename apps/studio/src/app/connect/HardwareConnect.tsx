/// <reference types="w3c-web-serial" />
import { useCallback, useEffect, useState } from 'react';
import { Cable, PlugZap, RefreshCw, Router, Usb } from 'lucide-react';
import { Button, IconButton, NumberField, TextField, toast } from '../../ui';
import { connection, describeError, DEFAULT_ROBORIO_HOST, ROBORIO_PORT, useConnection } from '../../core';
import { describeSerialPort, isWebSerialSupported, listGrantedSerialPorts } from '../../core/transports/webserial';
import { isTauri, listSerialPorts, type SerialPortInfo } from '../../core/transports/tauri';
import { readStored, writeStored } from '../../lib/storage';
import { tShell } from '../messages';

async function connectOrToast(p: Promise<boolean>): Promise<void> {
  await p;
  const { phase, error } = useConnection.getState();
  // A cancelled browser chooser is not an error worth shouting about.
  if (phase === 'error' && error && !/No port selected|cancel/i.test(error)) toast.error(tShell('conn.error'), { description: describeError(new Error(error)) });
}

function Passive({ text }: { text: string }) {
  return <p className="cy-hw__passive">{text}</p>;
}

export function WebSerialConnect({ onStarted }: { onStarted?: () => void }) {
  const supported = isWebSerialSupported();
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const refresh = useCallback(() => {
    if (supported) void listGrantedSerialPorts().then(setPorts, () => setPorts([]));
  }, [supported]);
  useEffect(refresh, [refresh]);
  if (!supported) return <Passive text={tShell('conn.webserialUnsupported')} />;
  return (
    <div className="cy-hw">
      <p className="cy-hw__intro">{tShell('conn.webserialIntro')}</p>
      <Button
        variant="primary"
        icon={Usb}
        onClick={() => {
          onStarted?.();
          // No port given: the manager opens the browser chooser inside this click.
          void connectOrToast(connection.connect({ kind: 'webserial' })).then(refresh);
        }}
      >
        {tShell('conn.choosePort')}
      </Button>
      <div className="cy-hw__label">{tShell('conn.grantedPorts')}</div>
      {ports.length === 0 && <div className="cy-hw__empty">{tShell('conn.noGranted')}</div>}
      {ports.map((p, i) => (
        <div key={i} className="cy-hw__row">
          <Cable size={15} aria-hidden />
          <span className="cy-hw__name cy-mono">{describeSerialPort(p)}</span>
          <Button
            size="sm"
            onClick={() => {
              onStarted?.();
              void connectOrToast(connection.connect({ kind: 'webserial', port: p }));
            }}
          >
            {tShell('conn.connect')}
          </Button>
        </div>
      ))}
    </div>
  );
}

export function DesktopSerialConnect({ onStarted }: { onStarted?: () => void }) {
  const tauri = isTauri();
  const [ports, setPorts] = useState<SerialPortInfo[] | null>(null);
  const refresh = useCallback(() => {
    if (tauri) void listSerialPorts().then(setPorts, () => setPorts([]));
  }, [tauri]);
  useEffect(refresh, [refresh]);
  if (!tauri) return <Passive text={tShell('conn.desktopOnly')} />;
  return (
    <div className="cy-hw">
      <div className="cy-hw__label">
        {tShell('conn.ports')}
        <IconButton size="sm" icon={RefreshCw} label={tShell('conn.refresh')} onClick={refresh} />
      </div>
      {ports?.length === 0 && <div className="cy-hw__empty">{tShell('conn.noPorts')}</div>}
      {ports?.map((p) => (
        <div key={p.path} className="cy-hw__row">
          <Usb size={15} aria-hidden />
          <span className="cy-hw__name">
            <span className="cy-mono">{p.path}</span>
            {p.product && <span className="cy-hw__sub">{p.product}</span>}
          </span>
          <Button
            size="sm"
            onClick={() => {
              onStarted?.();
              void connectOrToast(connection.connect({ kind: 'tauri-serial', path: p.path, label: p.product ?? p.path }));
            }}
          >
            {tShell('conn.connect')}
          </Button>
        </div>
      ))}
    </div>
  );
}

const HOST_KEY = 'cy.roborio.host';

export function RoboRioConnect({ onStarted }: { onStarted?: () => void }) {
  const tauri = isTauri();
  const [host, setHost] = useState(() => readStored(HOST_KEY) ?? DEFAULT_ROBORIO_HOST);
  const [port, setPort] = useState(ROBORIO_PORT);
  if (!tauri) return <Passive text={tShell('conn.desktopOnly')} />;
  return (
    <div className="cy-hw">
      <p className="cy-hw__intro">{tShell('conn.roborioIntro')}</p>
      <div className="cy-hw__form">
        <label className="cy-hw__field">
          <span>{tShell('conn.host')}</span>
          <TextField value={host} onChange={setHost} mono icon={Router} width={200} />
          <small>{tShell('conn.hostHint')}</small>
        </label>
        <label className="cy-hw__field">
          <span>{tShell('conn.port')}</span>
          <NumberField value={port} onCommit={setPort} integer min={1} max={65535} width={100} />
        </label>
      </div>
      <Button
        variant="primary"
        icon={PlugZap}
        disabled={!host.trim()}
        onClick={() => {
          writeStored(HOST_KEY, host.trim());
          onStarted?.();
          void connectOrToast(connection.connect({ kind: 'roborio', host: host.trim(), port }));
        }}
      >
        {tShell('conn.connect')}
      </Button>
    </div>
  );
}
