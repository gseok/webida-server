/*
 * Copyright (c) 2012-2015 S-Core Co., Ltd.
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var express = require('express');
var corser = require('corser');
var fs = require('fs');
var compression = require('compression');
var bodyParser = require('body-parser');

var logger = require('../common/log-manager');
var httpLogger = require('../common/http-logger');

var utils = require('../common/utils');
var extend = require('../common/inherit').extend;
var baseSvr = require('../common/n-svr').nSvr;
var baseSvc = require('../common/n-svc').Svc;

var appMgr = require('./lib/app-manager');
var config = require('../common/conf-manager').conf;
var profiler = require('../common/profiler');
//var awsMgr = require('./lib/aws-manager');


/**
 * Entry Point
 */

function urlParser(req, res, next) {
    req.parsedUrl = require('url').parse(req.url, true);
    next();
}

function webidaCookieSetter(req, res, next) {
    var conf = global.app.config;
    var appHostParsedUrl = require('url').parse(conf.appHostUrl);
    var option = {domain: (conf.useReverseProxy ? '.' : '') + conf.domain};
    res.cookie('webida.host', appHostParsedUrl.host, option);
    res.cookie('webida.appHostUrl', conf.appHostUrl, option);
    res.cookie('webida.authHostUrl', conf.authHostUrl, option);
    res.cookie('webida.fsHostUrl', conf.fsHostUrl, option);
    res.cookie('webida.buildHostUrl', conf.buildHostUrl, option);
    res.cookie('webida.ntfHostUrl', conf.ntfHostUrl, option);
    res.cookie('webida.corsHostUrl', conf.corsHostUrl, option);
    res.cookie('webida.connHostUrl', conf.connHostUrl, option);
    res.cookie('webida.monHostUrl', conf.monHostUrl, option);

    // set deploy options
    res.cookie('webida.deploy.type', conf.services.app.deploy.type, option);
    res.cookie('webida.deploy.pathPrefix', conf.services.app.deploy.pathPrefix, option);
    next();
}

function setXFrameOption (req, res, next) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
}

var register = function (server, unitName, svcType) {
    server.enable('trust proxy');

    server.set('view engine', 'ejs');
    server.set('views', __dirname + '/views');
    server.use(compression());
    server.use(setXFrameOption);
    server.use(corser.create({
        methods: ['GET', 'POST', 'DELETE'],
        requestHeaders: ['Authorization', 'Accept', 'Accept-Language', 'Content-Language', 'Content-Type',
            'Last-Event-ID', 'x-requested-with'],
        supportsCredentials: true,
        maxAge: 86400  // as 1 day
    }));
    server.use(httpLogger);
    server.use(bodyParser.urlencoded({ extended: true }));
    server.use(bodyParser.json());

    server.use(urlParser);
    server.use(webidaCookieSetter);
    //server.use(setCacheControl);
    if (global.app.config.runProfiler.enable) {
        var pattern = '\/webida\/api\/app/[^\/]*';
        server.use(profiler.globalProfile(unitName, svcType, pattern));
    }
    server.use(utils.senders);
    server.use(utils.onConnectError);
    /*
     * Aws API
     */
    //server.use(awsMgr.router.middleware);

    /**
     * App Service
     */
    server.use(appMgr.router);

    server.disable('x-powered-by');
};


var AppSvr = function (svc, svrName, conf) {
    baseSvr.call(this, svc, svrName, conf);

    this.svc = svc;
    this.httpServer = null;
    this.httpsServer = null;

    extend(AppSvr, baseSvr);
};


function startServer(self, conf) {
    var httpApp = express();
    register(httpApp, self.svc.unitName, self.svc.svcType);

    self.httpServer = httpApp.listen(conf.httpPort, conf.httpHost);
    logger.info('app http server is started on port ' + conf.httpPort);

    if (conf.httpsPort && conf.httpsHost) {
        // Set http Server ssl keys
        var options = {
            key: fs.readFileSync(conf.sslKeyPath, 'utf8'),
            cert: fs.readFileSync(conf.sslCertPath, 'utf8')
        };
        var httpsApp = express(options);
        register(httpsApp);
        self.httpsServer = httpsApp.listen(conf.httpsPort, conf.httpsHost);
        logger.info('app https server is started on port ' + conf.httpsPort);
    }
}


AppSvr.prototype.start = function () {
    var self = this;
    var conf = self.svc.config;
        
    if (config.services.app.startNodejsAppsOnStartup) {
        appMgr.startAllNodejsApps(function () {
            logger.info('AppSvr started all nodejs apps');
            startServer(self, conf);
        });
    } else {
        startServer(self, conf);
    }
};

AppSvr.prototype.stop = function () {
    var self = this;
    if (self.httpServer) {
        self.httpServer.close();
        self.httpServer = null;
    }

    if (self.httpsServer) {
        self.httpsServer.close();
        self.httpsServer = null;
    }

    appMgr.stopAllNodejsApps(function () {
    });
};

//
// AppSvc
//

var AppSvc = function (unitName, svcType, conf) {
    baseSvc.call(this, unitName, svcType, conf);
    this.appSvr = new AppSvr(this, 'app', conf);
};


extend(AppSvc, baseSvc);

AppSvc.prototype.start = function () {
    var self = this;
    self.appSvr.start();
};

AppSvc.prototype.stop = function () {
    var self = this;
    self.appSvr.stop();
};

AppSvc.prototype.started = function () {

};

AppSvc.prototype.stopped = function () {
};


exports.Svc = AppSvc;



