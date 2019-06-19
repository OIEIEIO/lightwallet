import { Injectable } from '@angular/core';
import Metaverse from 'metaversejs/dist/metaverse.js';
import { ConfigService } from './config.service';
import { Observable, BehaviorSubject, Subject, interval } from 'rxjs';
import { flatMap, first } from 'rxjs/operators';
import { combineLatest } from 'rxjs/observable/combineLatest';
import { WalletService } from './wallet.service';
import { MultisigService } from './multisig.service';
import { Storage } from '@ionic/storage';
import Blockchain from 'mvs-blockchain/dist/index';

export interface Transaction {
  height: number;
  hash: string;
}

export type Network = "mainnet" | "testnet";

@Injectable({
  providedIn: 'root'
})
export class MetaverseService {

  syncing$ = new BehaviorSubject<boolean>(false);
  transactions$ = new BehaviorSubject<Transaction[]>([]);
  height$ = new BehaviorSubject<number>(undefined);

  heartbeat$ = interval(5000);
  readonly network = this.config.defaultNetwork;

  blockchain: any;

  constructor(
    private config: ConfigService,
    private storage: Storage,
    private wallet: WalletService,
    private multisig: MultisigService,
  ) {
    this.setNetwork(this.config.defaultNetwork);
    this.restoreTransactions().then(txs => this.transactions$.next(txs));
    this.sync();
    this.heartbeat$.subscribe(() => this.sync());
  }

  reset() {
    this.height$.next(undefined);
    this.storage.remove('transactions');
    this.transactions$.next([]);
  }

  loaderCondition() {
    return this.wallet.addresses$.value &&
      this.wallet.addresses$.value.length;
  }

  async sync() {
    if (await this.syncing$.value === true || !this.loaderCondition()) {
      return;
    }
    this.syncing$.next(true);
    try {
      await this.updateHeight();
      await this.getData();
    } catch (error) {
      console.error(error);
      this.syncing$.next(false);
    }
    this.syncing$.next(false);
  }

  setNetwork(network: Network) {
    this.blockchain = Blockchain({ network: this.network });
  }

  utxos$ = (addresses$: Observable<string[]>) => combineLatest([
    this.transactions$,
    addresses$,
  ]).pipe(
    flatMap(([transactions, addresses]) => Metaverse.output.calculateUtxo(transactions, addresses))
  )

  private async getData(): Promise<any> {
    console.log('getting data')
    const addresses = await this.wallet.getAddresses();
    addresses.concat(await this.multisig.getMultisigAddresses());
    let newTxs = await this.getNewTxs(addresses, await this.getLastTxHeight());
    const newTransactionsFound = newTxs && newTxs.length;
    while (newTxs && newTxs.length) {
      newTxs = await this.getNewTxs(addresses, await this.getLastTxHeight());
      this.transactions$.next(await this.restoreTransactions());
    }
    if (newTransactionsFound) {
      this.transactions$.next(await this.restoreTransactions());
    }
  }

  async updateHeight() {
    const height = await this.blockchain.height();
    this.height$.next(height);
  }

  async getLastTxHeight() {
    const transactions = await (this.transactions$.pipe(first())).toPromise();
    if (!transactions || transactions.length === 0) {
      return 0;
    }
    return transactions[0].height;
  }

  async getNewTxs(addresses: Array<string>, lastKnownHeight: number): Promise<any> {
    const newTxs = await this.loadNewTxs(addresses, lastKnownHeight + 1);
    return this.storeTransactions(newTxs);
  }

  loadNewTxs(addresses: Array<string>, start: number) {
    return this.blockchain.addresses.listTxs(addresses, { min_height: start })
      .catch((error: Error) => {
        console.log('error loading transactions');
        throw Error('ERR_SYNC_NEW_TRANSACTIONS');
      });
  }

  async storeTransactions(newtxs: Array<any>) {
    if (newtxs === undefined || newtxs.length === 0) {
      return newtxs;
    }
    let txs = await this.restoreTransactions();
    newtxs = newtxs.sort((a: any, b: any) => a.height - b.height);
    newtxs.forEach((newtx) => {
      const found = this.findTxIndexByHash(txs, newtx.hash);
      if (found === -1) {
        txs = [newtx].concat(txs);
      } else {
        txs[found] = newtx;
      }
    });
    await this.storage.set('transactions', txs);
    return newtxs;
  }

  private findTxIndexByHash = (txs: Transaction[], hash: string) => txs.findIndex(tx => tx.hash === hash)

  async restoreTransactions() {
    return await this.storage.get('transactions') || [];
  }

  public sortByTransactionHeight(a: Transaction, b: Transaction) {
    return b.height - a.height;
  }

  getTickers = () => this.blockchain.pricing.tickers();

  getBlocktime(current_height) {
    console.log("Getting blocktime from height " + current_height)
    let downscale = 10;
    return this.storage.get('blocktime')
      .then((blocktime) => {
        if (blocktime == undefined || blocktime.height == undefined || current_height > blocktime.height + 1000) {
          return this.blockchain.block.blocktime(downscale)
            .then((time) => {
              this.setBlocktime(time, current_height)
              return time
            })
        } else {
          return blocktime.time
        }
      })
      .catch((error) => {
        console.error(error)
        throw Error('ERR_GET_BLOCKTIME')
      })
  }

  setBlocktime(time, height) {
    var blocktime = {};
    blocktime['time'] = time
    blocktime['height'] = height
    return this.storage.set('blocktime', blocktime)
  }

}
