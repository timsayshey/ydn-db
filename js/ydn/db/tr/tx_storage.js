/**
 * @fileoverview Light wrapper {@link ydn.db.Storage} using active transaction
 * instance given at constructor.
 *
 * Creating multiple transaction facility added.
 */


goog.provide('ydn.db.tr.TxStorage');
goog.require('ydn.error.NotSupportedException');


/**
 * @implements {ydn.db.tr.IStorage}
 * @implements {ydn.db.tr.ITxStorage}
 * @param {!ydn.db.tr.Storage} storage
 * @param {number} ptx_no
 * @constructor
 */
ydn.db.tr.TxStorage = function(storage, ptx_no) {
  /**
   * @final
   * @type {!ydn.db.tr.Storage}
   * @private
   */
  this.storage_ = storage;

  this.mu_tx_ = new ydn.db.tr.Mutex();

  /*
   * Transaction queue no.
   */
  this.ptx_no_ = ptx_no;

};



/**
 * @protected
 * @type {goog.debug.Logger} logger.
 */
ydn.db.tr.TxStorage.prototype.logger =
  goog.debug.Logger.getLogger('ydn.db.tr.TxStorage');


/**
 * One database can have only one transaction.
 * @private
 * @type {ydn.db.tr.Mutex}
 */
ydn.db.tr.TxStorage.prototype.mu_tx_ = null;


/**
 *
 * @return {!ydn.db.tr.Mutex}
 */
ydn.db.tr.TxStorage.prototype.getMuTx = function() {
  return /** @type {!ydn.db.tr.Mutex} */ (this.mu_tx_);
};


/**
 *
 * @return {number}
 */
ydn.db.tr.TxStorage.prototype.getTxNo = function() {
  return this.mu_tx_.getTxCount();
};


/**
 * Obtain active consumable transaction object.
 * @return {ydn.db.tr.Mutex} transaction object if active and available.
 */
ydn.db.tr.TxStorage.prototype.getActiveTx = function() {
  return this.mu_tx_.isActiveAndAvailable() ? this.mu_tx_ : null;
};



/**
 *
 * @return {boolean}
 */
ydn.db.tr.TxStorage.prototype.isActive = function() {
  return this.mu_tx_.isActiveAndAvailable();
};


/**
 *
 * @return {!ydn.db.tr.Storage}
 */
ydn.db.tr.TxStorage.prototype.getStorage = function() {
  return this.storage_;
};


/**
 *
 * @return {SQLTransaction|IDBTransaction|Object}
 */
ydn.db.tr.TxStorage.prototype.getTx = function() {
  return this.mu_tx_.isActiveAndAvailable() ? this.mu_tx_.getTx() : null;
};



/**
 * Transaction is explicitly set not to do next transaction.
 */
ydn.db.tr.TxStorage.prototype.lock = function() {
  this.mu_tx_.lock();
};


/**
 * Add a transaction complete (also error and abort) event. The listener will
 * be invoked after receiving one of these three events and before executing
 * next transaction. However, it is recommended that listener is not used
 * for transaction logistic tracking, which should, in fact, be tracked request
 * level. Use this listener to release resource for robustness. Any error on
 * the listener will be swallowed.
 * @final
 * @param {?function(string=, *=)} fn first argument is either 'complete',
 * 'error', or 'abort' and second argument is event.
 */
ydn.db.tr.TxStorage.prototype.setCompletedListener = function(fn) {
  this.mu_tx_.oncompleted = fn || null;
};



/**
 *
 * @inheritDoc
 */
ydn.db.tr.TxStorage.prototype.type = function() {
  return this.storage_.type();
};


/**
 * @inheritDoc
 */
ydn.db.tr.TxStorage.prototype.close = function() {
  return this.storage_.close();
};



/**
 *
 * @type {number}
 * @private
 */
ydn.db.tr.TxStorage.prototype.last_queue_checkin_ = NaN;


/**
 * @const
 * @type {number}
 */
ydn.db.tr.TxStorage.MAX_QUEUE = 1000;


/**
 *
 * @type {!Array.<{fnc: Function, scope: string, store_names: Array.<string>,
 * mode: ydn.db.TransactionMode, oncompleted: Function}>}
 * @private
 */
ydn.db.tr.TxStorage.prototype.trQueue_ = [];


/**
 * Run the first transaction task in the queue. DB must be ready to do the
 * transaction.
 * @private
 */
ydn.db.tr.TxStorage.prototype.popTxQueue_ = function() {

  var task = this.trQueue_.shift();
  if (task) {
    ydn.db.tr.TxStorage.prototype.transaction.call(this,
      task.fnc, task.scope, task.store_names, task.mode, task.oncompleted);
  }
  this.last_queue_checkin_ = goog.now();
};

/**
 * Push a transaction job to the queue.
 * @param {Function} trFn function that invoke in the transaction.
 * @param {string} scope
 * @param {!Array.<string>} store_names list of keys or
 * store name involved in the transaction.
 * @param {ydn.db.TransactionMode=} opt_mode mode, default to 'readonly'.
 * @param {function(ydn.db.TransactionEventTypes, *)=} completed_event_handler
 * @private
 */
ydn.db.tr.TxStorage.prototype.pushTxQueue_ = function (trFn, scope, store_names,
                                                       opt_mode, completed_event_handler) {
  this.trQueue_.push({
    fnc:trFn,
    scope: scope,
    store_names:store_names,
    mode:opt_mode,
    oncompleted:completed_event_handler
  });
  var now = goog.now();
  if (!isNaN(this.last_queue_checkin_)) {
    if ((now - this.last_queue_checkin_) > ydn.db.core.Storage.timeOut) {
      this.logger.warning('queue is not moving.');
      // todo: actively push the queue if transaction object is available
      // this will make robustness to the app.
      // in normal situation, queue will automatically empty since
      // pop queue will call whenever transaction is finished.
    }
  }
  if (this.trQueue_.length > ydn.db.core.Storage.MAX_QUEUE) {
    this.logger.warning('Maximum queue size exceed, dropping the first job.');
    this.trQueue_.shift();
  }

};


/**
 * Create a new isolated transaction. After creating a transaction, use
 * {@link #getTx} to received an active transaction. If transaction is not
 * active, it return null. In this case a new transaction must re-create.
 * @export
 * @param {Function} trFn function that invoke in the transaction.
 * @param {!Array.<string>} store_names list of keys or
 * store name involved in the transaction.
 * @param {ydn.db.TransactionMode=} opt_mode mode, default to 'readonly'.
 * @param {function(ydn.db.TransactionEventTypes, *)=} oncompleted
 * @param {...} opt_args
 * @override
 */
ydn.db.tr.TxStorage.prototype.transaction = function (trFn, store_names, opt_mode, oncompleted, opt_args) {

  //console.log('tr starting ' + trFn.name);
  var scope_name = trFn.name || '';

  var names = store_names;
  if (goog.isString(store_names)) {
    names = [store_names];
  } else if (!goog.isArray(store_names) ||
    (store_names.length > 0 && !goog.isString(store_names[0]))) {
    throw new ydn.error.ArgumentException("storeNames");
  }
  var mode = goog.isDef(opt_mode) ? opt_mode : ydn.db.TransactionMode.READ_ONLY;
  var outFn = trFn;
  if (arguments.length > 4) { // handle optional parameters
    // see how this works in goog.partial.
    var args = Array.prototype.slice.call(arguments, 4);
    outFn = function () {
      // Prepend the bound arguments to the current arguments.
      var newArgs = Array.prototype.slice.call(arguments);
      newArgs.unshift.apply(newArgs, args);
      return trFn.apply(this, newArgs);
    }
  }

  var me = this;

  if (this.mu_tx_.isActiveAndAvailable()) {
    this.pushTxQueue_(outFn, scope_name, store_names, mode, oncompleted);
  } else {
  
    var transaction_process = function (tx) {

      //console.log('tr running ' + trFn.name);

      me.mu_tx_.up(tx, scope_name);

      // now execute transaction process
      trFn(me);
      me.mu_tx_.out(); // flag transaction callback scope is over.
      // transaction is still active and use in followup request handlers
    };

    var completed_handler = function (type, event) {
      me.mu_tx_.down(type, event);
      if (goog.isFunction(oncompleted)) {
        /**
         * @preserve_try
         */
        try {
          oncompleted(type, event);
        } catch (e) {
          // swallow error. document it publicly.
          // this is necessary and
          if (goog.DEBUG) {
            throw e;
          }
        }
      }
    };

    this.storage_.newTransaction(transaction_process, names, mode, completed_handler);
  }

};


/** @override */
ydn.db.tr.TxStorage.prototype.toString = function() {
  var s = 'ydn.db.tr.TxStorage:' + this.storage_.getName();
  if (goog.DEBUG) {
    var scope = this.mu_tx_.getScope();
    scope = scope ? ' [' + scope + ']' : '';
    return s + ':' + this.ptx_no_ + ':' + this.getTxNo() + scope;
  }
  return s;
};